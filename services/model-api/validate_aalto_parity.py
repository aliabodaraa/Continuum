"""Check that aalto_to_windows.py builds exactly the features the live code builds.

Both implementations get the same keystrokes. Each section becomes the keydown/keyup
events a browser would have sent (aalto_to_windows.keystroke_events); Node runs those
events through eventSteps() and eventsToFeatureWindows() of
services/ca-service/lib/keystrokeSecurity.js, and the result is compared with
aalto_to_windows.build_steps() and steps_to_windows(). Digraph rows are compared value by
value (both sides compute in float64), and window counts per section must agree. Rows are
compared, not only windows, because most Aalto sentences are too short to fill a window.

Sections come from a seeded generator that exercises every rule (rollover, pauses at and
over 1 s, sub-15 ms digraphs, sub-10 ms dwells, repeated and overlapping keys, releases
before presses, missing releases) and, with --aalto, from real participant files.

The Node side loads keystrokeSecurity.js with its two service imports stubbed and every
other import refused, so nothing touches a database or the model-api.

Runs on the host (it needs both python and node), from the repository root:
    python services/model-api/validate_aalto_parity.py
    python services/model-api/validate_aalto_parity.py --aalto data/Keystrokes/files --files 200
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import aalto_to_windows as A  # noqa: E402

KS_JS = os.path.normpath(os.path.join(HERE, "..", "ca-service", "lib", "keystrokeSecurity.js"))

HARNESS = r"""
const fs = require("fs");
const Module = require("module");
const [file, input] = process.argv.slice(1);
const builtin = new Set(Module.builtinModules);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./trainingQueue" || request === "./modelClient") return {};
  if (builtin.has(request) || request.startsWith("node:")) return origLoad.apply(this, arguments);
  throw new Error("parity harness: refused require('" + request + "')");
};
const m = new Module(file, module);
m.filename = file;
m._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.__eventSteps = eventSteps;\n", file);
const ks = m.exports;
const sections = JSON.parse(fs.readFileSync(input, "utf8"));
const out = sections.map((ev) => [ks.__eventSteps(ev), ks.eventsToFeatureWindows(ev).length]);
process.stdout.write(JSON.stringify(out));
"""


def to_browser_events(keystrokes):
    return [{"keyCode": kc, "eventType": "keydown" if is_down else "keyup",
             "timestampRelative": t, "fieldName": "sentence"}
            for t, is_down, kc in A.keystroke_events(keystrokes)]


def synthetic_sections(n_sections, seed):
    rng = np.random.default_rng(seed)
    keys = [8, 16, 32, 65, 66, 67, 68, 69, 72, 73, 76, 78, 79, 82, 83, 84, 85, 188, 190]
    sections = []
    for _ in range(n_sections):
        n = int(rng.integers(20, 160))
        t = 1_473_275_000_000 + int(rng.integers(0, 10 ** 7))
        prev, keystrokes = None, []
        for i in range(n):
            u = rng.random()
            if u < 0.05:
                gap = int(rng.integers(1001, 3000))          # composition pause
            elif u < 0.07:
                gap = 1000                                   # exactly the pause boundary (kept)
            elif u < 0.10:
                gap = int(rng.integers(0, 15))               # batching artefact, ties included
            else:
                gap = max(1, int(rng.lognormal(np.log(160), 0.4)))
            t += gap if i else 0
            v = rng.random()
            if v < 0.03:
                dwell = int(rng.integers(0, 10))             # too short to be human
            elif v < 0.04:
                dwell = -int(rng.integers(1, 50))            # release before press
            else:
                dwell = max(1, int(rng.lognormal(np.log(90), 0.35)))
            kc = prev if (prev is not None and rng.random() < 0.04) else int(rng.choice(keys))
            release = None if rng.random() < 0.02 else float(t + dwell)
            keystrokes.append((float(t), release, kc))
            prev = kc
        sections.append(keystrokes)
    return sections


def real_sections(src, n_files, seed):
    files = sorted(glob.glob(os.path.join(src, "*_keystrokes.txt")))
    if not files:
        raise SystemExit(f"no *_keystrokes.txt under {src}")
    rng = np.random.default_rng(seed)
    pick = sorted(rng.choice(len(files), size=min(n_files, len(files)), replace=False))
    sections = []
    for i in pick:
        _, secs, _, _ = A.read_participant(files[i])
        sections.extend(secs.values())
    return sections, len(pick)


def compare(label, sections):
    for keystrokes in sections:
        keystrokes.sort(key=lambda e: e[0])       # as participant_windows() does
    events = [to_browser_events(k) for k in sections]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(events, f)
        path = f.name
    try:
        run = subprocess.run(["node", "-e", HARNESS, KS_JS, path],
                             capture_output=True, text=True, check=False)
    finally:
        os.unlink(path)
    if run.returncode != 0:
        raise SystemExit(f"node failed:\n{run.stderr}")
    js = json.loads(run.stdout)

    bad, rows, windows = [], 0, 0
    for i, (keystrokes, (js_steps, js_windows)) in enumerate(zip(sections, js)):
        py_steps = A.build_steps(keystrokes)
        py_windows = len(A.steps_to_windows(py_steps))
        rows += len(py_steps)
        windows += py_windows
        if py_steps != js_steps or py_windows != js_windows:
            bad.append((i, len(py_steps), len(js_steps), py_windows, js_windows))
    print(f"{label}: {len(sections)} sections, {rows} digraph rows, {windows} windows; "
          f"{'identical' if not bad else f'{len(bad)} sections differ'}")
    for i, pr, jr, pw, jw in bad[:5]:
        print(f"  section {i}: python {pr} rows / {pw} windows, node {jr} rows / {jw} windows")
    return not bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sections", type=int, default=1500, help="synthetic sections")
    ap.add_argument("--seed", type=int, default=20260924)
    ap.add_argument("--aalto", help="unzipped Aalto files/ directory (optional)")
    ap.add_argument("--files", type=int, default=200, help="real participant files to sample")
    args = ap.parse_args()

    ok = compare("synthetic", synthetic_sections(args.sections, args.seed))
    if args.aalto:
        sections, n = real_sections(args.aalto, args.files, args.seed)
        ok = compare(f"Aalto, {n} participants", sections) and ok
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
