"""
Convert the Aalto 136M-keystrokes dataset into Continuum's 50x6 windows.

Why this exists: the keystroke base model was evaluated with an OVERLAP-aware split,
not a SUBJECT-disjoint one. data/Rand_WS50.h5 carries no subject labels at all, so the
same typist can appear in both train and test — that measures partial memorisation, not
whether the system works for a person it has never seen. (The mouse channel already has
a subject-disjoint number, 20 held-out users, which is why the two are not comparable.)
Aalto supplies 168,000 identified participants with raw press/release timestamps, giving
real, subject-disjoint impostors for the first time.

Dataset: Dhakal, Feit, Kristensson & Oulasvirta, "Observations on Typing from 136
Million Keystrokes", CHI 2018. Free for research/non-commercial use with attribution.
http://userinterfaces.aalto.fi/136Mkeystrokes

Columns (tab-separated):
    PARTICIPANT_ID  TEST_SECTION_ID  SENTENCE  USER_INPUT  KEYSTROKE_ID
    PRESS_TIME  RELEASE_TIME  LETTER  KEYCODE

The feature construction below is a port of buildSteps() in
services/ca-service/lib/keystrokeSecurity.js and MUST stay identical to it. Windows
built by a different rule are out-of-distribution for the trained head, and the
resulting FAR would measure that mismatch rather than the impostor.

Caveats to state wherever these numbers appear:
  * Aalto is a TRANSCRIPTION task (participants copy given sentences), so it matches
    Continuum's copy-typing enrollment but not free composition.
  * Sentences are short (<=70 chars), so windows come from within one sentence.
  * Collection conditions differ from Buffalo (domain shift).

Usage (inside the model-api container):
    python aalto_to_windows.py --src /app/data/Keystrokes/files \
        --out /app/data/aalto_impostors.h5 --max-participants 200
"""
import argparse
import glob
import os

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

# --- constants: MUST equal ca-service/lib/keystrokeSecurity.js -------------
WINDOW_SIZE = 50
WINDOW_STRIDE = 10
PAUSE_DD_SECONDS = 1.0        # composition pause -> digraph dropped, run NOT broken
MIN_HUMAN_DD_SECONDS = 0.015  # below this is event batching, not typing
MIN_HUMAN_DWELL_SECONDS = 0.01
KEYCODE_SCALE = 254.0         # clamp01(keyCode / 254)


def clamp01(v):
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def build_steps(events):
    """events: [(press_ms, release_ms, keycode)] in keystroke order for ONE test
    section. Returns 6-feature digraph rows [id1, id2, dwell1, dwell2, dd, ud].

    Mirrors buildSteps(): pair consecutive keydowns, derive the four timings, drop
    impossible ones, then drop long gaps WITHOUT breaking the run so the fluent typing
    either side is spliced together (dropping-not-breaking is what keeps composition
    pauses out of the features while still producing windows)."""
    raw = []
    for i in range(len(events) - 1):
        p1, r1, k1 = events[i]
        p2, r2, k2 = events[i + 1]
        dwell1 = (r1 - p1) / 1000.0
        dwell2 = (r2 - p2) / 1000.0
        dd = (p2 - p1) / 1000.0
        ud = (p2 - r1) / 1000.0
        if dwell1 < 0 or dwell2 < 0 or dd < 0:
            continue
        if (dd < MIN_HUMAN_DD_SECONDS
                or dwell1 < MIN_HUMAN_DWELL_SECONDS
                or dwell2 < MIN_HUMAN_DWELL_SECONDS):
            continue
        raw.append((
            [clamp01(k1 / KEYCODE_SCALE), clamp01(k2 / KEYCODE_SCALE),
             dwell1, dwell2, dd, ud],
            dd,
        ))
    return [row for row, dd in raw if dd <= PAUSE_DD_SECONDS]


def steps_to_windows(steps):
    if len(steps) < WINDOW_SIZE:
        return []
    a = np.asarray(steps, dtype=np.float32)
    return [a[s:s + WINDOW_SIZE]
            for s in range(0, len(a) - WINDOW_SIZE + 1, WINDOW_STRIDE)]


def participant_windows(path):
    """One Aalto participant file -> (participant_id, windows).

    Keystrokes are grouped by TEST_SECTION_ID: each section is one sentence typed as a
    continuous act. Concatenating across sections would invent a digraph spanning the
    gap between two unrelated sentences, so sections are kept apart."""
    sections, pid = {}, None
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        header = f.readline().rstrip("\n").split("\t")
        idx = {name.strip().upper(): i for i, name in enumerate(header)}
        need = ("PARTICIPANT_ID", "TEST_SECTION_ID", "PRESS_TIME", "RELEASE_TIME", "KEYCODE")
        if not all(n in idx for n in need):
            return None, []
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) <= idx["KEYCODE"]:
                continue
            try:
                pid = p[idx["PARTICIPANT_ID"]]
                sec = p[idx["TEST_SECTION_ID"]]
                press = float(p[idx["PRESS_TIME"]])
                rel = float(p[idx["RELEASE_TIME"]])
                kc = int(float(p[idx["KEYCODE"]]))
            except ValueError:
                continue
            sections.setdefault(sec, []).append((press, rel, kc))

    wins = []
    for sec in sections.values():
        sec.sort(key=lambda e: e[0])          # keystroke order = press time
        wins.extend(steps_to_windows(build_steps(sec)))
    return pid, wins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="dir containing *_keystrokes.txt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-participants", type=int, default=200)
    ap.add_argument("--min-windows", type=int, default=10,
                    help="skip participants yielding fewer windows than this")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    files = sorted(glob.glob(os.path.join(args.src, "*_keystrokes.txt")))
    print(f"found {len(files)} participant files")
    if not files:
        raise SystemExit("no *_keystrokes.txt under --src")

    X, groups, kept, skipped = [], [], 0, 0
    for path in files:
        if kept >= args.max_participants:
            break
        pid, wins = participant_windows(path)
        if pid is None or len(wins) < args.min_windows:
            skipped += 1
            continue
        X.extend(wins)
        groups.extend([int(pid)] * len(wins))
        kept += 1
        if kept % 25 == 0:
            print(f"  {kept} participants, {len(X)} windows")

    if not X:
        raise SystemExit("no windows produced — check --src points at the files/ dir")

    X = np.asarray(X, dtype=np.float32)
    groups = np.asarray(groups, dtype=np.int64)
    counts = np.bincount(np.unique(groups, return_inverse=True)[1])
    print(f"participants kept={kept} skipped={skipped}  windows={X.shape}")
    print(f"per-participant windows: min={counts.min()} median={int(np.median(counts))} max={counts.max()}")

    with h5py.File(args.out, "w") as f:
        f.create_dataset("windows", data=X, compression="gzip")
        f.create_dataset("participant", data=groups, compression="gzip")
        f.attrs["source"] = "Aalto 136M keystrokes (Dhakal et al., CHI 2018)"
        f.attrs["features"] = "id1,id2,dwell1,dwell2,dd,ud"
        f.attrs["built_by"] = "aalto_to_windows.py (port of ca-service buildSteps)"
        f.attrs["window_size"] = WINDOW_SIZE
        f.attrs["window_stride"] = WINDOW_STRIDE
    print("wrote", args.out)


if __name__ == "__main__":
    main()
