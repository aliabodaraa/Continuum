"""
Convert the KeyRecs free-text dataset into Continuum's 50x6 windows.

Why this exists
---------------
The keystroke base model was evaluated with an OVERLAP-aware split, not a SUBJECT-disjoint
one: data/Rand_WS50.h5 carries no subject labels, so the same typist can sit on both sides
of the split. That measures partial memorisation, not whether the system recognises a person
it has never seen. (The mouse channel already has a subject-disjoint number — 20 held-out
users — which is exactly why the two channels are not comparable as reported.)

The app's own users cannot fill the gap either: each per-user model was trained with
negativeSource="app-users+dataset", so scoring one app user against another's model is
train/test contamination, and several "users" are the same human under two ids.

KeyRecs supplies 99 identified participants who have never been seen by the base model or by
any per-user head — real, subject-disjoint impostors.

Dataset: Dias, Vitorino, Maia, Sousa & Praça, "KeyRecs: A keystroke dynamics and typing
pattern recognition dataset", Data in Brief, 2023. CC-BY 4.0.
https://doi.org/10.5281/zenodo.7886742

Format (free-text.csv), one row per digraph, rows sequential within participant+session:
    participant, session, key1, key2,
    DU.key1.key1, DD.key1.key2, DU.key1.key2, UD.key1.key2, UU.key1.key2

Mapping to Continuum's six features:
    dwell1 = DU.key1.key1                 (press->release of key1)
    dd     = DD.key1.key2                 (press->press)
    ud     = UD.key1.key2                 (release->press)
    dwell2 = UU.key1.key2 - UD.key1.key2  (release->release minus release->press)
Cross-check available in the data: DD + dwell2 must equal DU.key1.key2.

Filtering and windowing are a port of buildSteps() in
services/ca-service/lib/keystrokeSecurity.js and must stay identical to it — windows built
by a different rule are out-of-distribution for the trained head, and the resulting FAR would
measure that mismatch rather than the impostor.

Caveats to state wherever these numbers appear:
  * KeyRecs is a TRANSCRIPTION exercise, so it matches Continuum's copy-typing enrollment
    but not free composition.
  * key1/key2 are JS `event.key` NAMES; the model wants `event.keyCode`. The mapping below is
    faithful for letters, digits and common punctuation but is an approximation for a few
    keys, so id1/id2 carry slightly more noise than the four timing features.

Usage (inside the model-api container):
    python keyrecs_to_windows.py --src /app/data/keyrecs/free-text.csv \
        --out /app/data/keyrecs_impostors.h5
"""
import argparse
import csv
import os

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

# --- constants: MUST equal ca-service/lib/keystrokeSecurity.js -------------
WINDOW_SIZE = 50
WINDOW_STRIDE = 10
PAUSE_DD_SECONDS = 1.0
MIN_HUMAN_DD_SECONDS = 0.015
MIN_HUMAN_DWELL_SECONDS = 0.01
KEYCODE_SCALE = 254.0

# event.key name -> event.keyCode. Letters/digits are exact; punctuation uses the
# standard US-layout codes the browser reports.
NAMED_KEYS = {
    "space": 32, "backspace": 8, "shift": 16, "control": 17, "ctrl": 17, "alt": 18,
    "enter": 13, "return": 13, "tab": 9, "capslock": 20, "escape": 27, "esc": 27,
    "arrowleft": 37, "arrowup": 38, "arrowright": 39, "arrowdown": 40,
    "delete": 46, "home": 36, "end": 35, "pageup": 33, "pagedown": 34, "meta": 91,
}
PUNCT = {
    ";": 186, ":": 186, "=": 187, "+": 187, ",": 188, "<": 188, "-": 189, "_": 189,
    ".": 190, ">": 190, "/": 191, "?": 191, "`": 192, "~": 192, "[": 219, "{": 219,
    "\\": 220, "|": 220, "]": 221, "}": 221, "'": 222, '"': 222,
    "!": 49, "@": 50, "#": 51, "$": 52, "%": 53, "^": 54, "&": 55, "*": 56,
    "(": 57, ")": 48,
}


def keycode_of(name):
    """Best-effort event.key -> event.keyCode. Returns None for anything unmapped so the
    digraph can be dropped rather than silently given a wrong id."""
    if name is None:
        return None
    n = name.strip()
    if not n:
        return None
    low = n.lower()
    if low in NAMED_KEYS:
        return NAMED_KEYS[low]
    if len(n) == 1:
        if n.isalpha():
            return ord(n.upper())
        if n.isdigit():
            return ord(n)
        if n in PUNCT:
            return PUNCT[n]
    return None


def build_steps(rows):
    """rows: sequential digraph dicts for ONE participant+session -> 6-feature rows.

    Mirrors buildSteps(): drop impossible timings, then drop gaps over PAUSE_DD_SECONDS
    WITHOUT breaking the run, so fluent typing either side of a pause is spliced together."""
    steps = []
    for r in rows:
        k1, k2 = keycode_of(r["key1"]), keycode_of(r["key2"])
        if k1 is None or k2 is None:
            continue
        # .get() + KeyError guard: a truncated or short row yields a dict missing the later
        # columns, and one malformed line must not abort a 500k-row conversion.
        try:
            dwell1 = float(r["DU.key1.key1"])
            dd = float(r["DD.key1.key2"])
            ud = float(r["UD.key1.key2"])
            uu = float(r["UU.key1.key2"])
        except (KeyError, TypeError, ValueError):
            continue
        dwell2 = uu - ud                     # release->release minus release->press
        if dwell1 < 0 or dwell2 < 0 or dd < 0:
            continue                         # overlapping keys (e.g. Shift held) -> skip
        if (dd < MIN_HUMAN_DD_SECONDS
                or dwell1 < MIN_HUMAN_DWELL_SECONDS
                or dwell2 < MIN_HUMAN_DWELL_SECONDS):
            continue
        if dd > PAUSE_DD_SECONDS:
            continue                         # composition pause — dropped, run not broken
        steps.append([min(max(k1 / KEYCODE_SCALE, 0.0), 1.0),
                      min(max(k2 / KEYCODE_SCALE, 0.0), 1.0),
                      dwell1, dwell2, dd, ud])
    return steps


def steps_to_windows(steps):
    if len(steps) < WINDOW_SIZE:
        return []
    a = np.asarray(steps, dtype=np.float32)
    return [a[s:s + WINDOW_SIZE]
            for s in range(0, len(a) - WINDOW_SIZE + 1, WINDOW_STRIDE)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="KeyRecs free-text.csv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-participants", type=int, default=0, help="0 = all")
    ap.add_argument("--min-windows", type=int, default=10)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    # Group rows by participant+session; each session is one continuous typing act.
    # The shipped header is not clean: the last column is named "UU.key1.key2 " (trailing
    # space) and there is a trailing empty field. Normalise names so lookups are reliable.
    sessions = {}
    with open(args.src, "r", encoding="utf-8", errors="ignore", newline="") as f:
        rdr = csv.reader(f)
        header = [h.strip() for h in next(rdr)]
        for parts in rdr:
            if not parts:
                continue
            r = {header[i]: parts[i] for i in range(min(len(header), len(parts)))}
            p = (r.get("participant") or "").strip()
            if not p:
                continue
            sessions.setdefault((p, (r.get("session") or "").strip()), []).append(r)
    print(f"loaded {len(sessions)} participant-sessions")

    by_participant = {}
    for (p, _sess), rows in sessions.items():
        by_participant.setdefault(p, []).extend(steps_to_windows(build_steps(rows)))

    X, groups, kept, skipped = [], [], 0, 0
    pid_map = {}
    for p in sorted(by_participant):
        wins = by_participant[p]
        if len(wins) < args.min_windows:
            skipped += 1
            continue
        if args.max_participants and kept >= args.max_participants:
            break
        pid_map[p] = kept
        X.extend(wins)
        groups.extend([kept] * len(wins))
        kept += 1

    if not X:
        raise SystemExit("no windows produced")

    X = np.asarray(X, dtype=np.float32)
    groups = np.asarray(groups, dtype=np.int64)
    counts = np.bincount(groups)
    print(f"participants kept={kept} skipped={skipped} (too few windows)")
    print(f"windows={X.shape}  per-participant min={counts.min()} "
          f"median={int(np.median(counts))} max={counts.max()}")
    # sanity: timing features should look like human typing, not garbage
    print(f"dwell1 median={np.median(X[:, :, 2]):.3f}s  dd median={np.median(X[:, :, 4]):.3f}s")

    with h5py.File(args.out, "w") as f:
        f.create_dataset("windows", data=X, compression="gzip")
        f.create_dataset("participant", data=groups, compression="gzip")
        f.attrs["source"] = "KeyRecs free-text (Dias et al., Data in Brief 2023, CC-BY 4.0)"
        f.attrs["features"] = "id1,id2,dwell1,dwell2,dd,ud"
        f.attrs["built_by"] = "keyrecs_to_windows.py (port of ca-service buildSteps)"
        f.attrs["window_size"] = WINDOW_SIZE
        f.attrs["window_stride"] = WINDOW_STRIDE
    print("wrote", args.out)


if __name__ == "__main__":
    main()
