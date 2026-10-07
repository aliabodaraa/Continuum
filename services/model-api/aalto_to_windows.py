"""
Convert the Aalto 136M-keystrokes dataset into Continuum's 50x6 windows.

Why this exists: the keystroke base model was evaluated with an OVERLAP-aware split,
not a SUBJECT-disjoint one. data/Rand_WS50.h5 carries no subject labels at all, so the
same typist can appear in both train and test — that measures partial memorisation, not
whether the system works for a person it has never seen. (The mouse channel already has
a subject-disjoint number, 20 held-out users, which is why the two are not comparable.)
Aalto supplies 168,000 identified participants with raw press/release timestamps, giving
real, subject-disjoint impostors for the first time, and enough typists to train a
shared embedding (recovery plan, Phase 3).

Dataset: Dhakal, Feit, Kristensson & Oulasvirta, "Observations on Typing from 136
Million Keystrokes", CHI 2018. Free for research/non-commercial use with attribution.
http://userinterfaces.aalto.fi/136Mkeystrokes

Columns (tab-separated):
    PARTICIPANT_ID  TEST_SECTION_ID  SENTENCE  USER_INPUT  KEYSTROKE_ID
    PRESS_TIME  RELEASE_TIME  LETTER  KEYCODE

The feature construction below is a port of eventSteps() in
services/ca-service/lib/keystrokeSecurity.js and MUST stay identical to it. Windows
built by a different rule are out-of-distribution for the trained head, and the
resulting FAR would measure that mismatch rather than the impostor. Each Aalto keystroke
is turned into the keydown/keyup events a browser would have sent, and those events go
through the same pairing as the live code; validate_aalto_parity.py runs both
implementations on the same keystrokes and requires identical windows.

Caveats to state wherever these numbers appear:
  * Aalto is a TRANSCRIPTION task (participants copy given sentences), so it matches
    Continuum's copy-typing enrollment but not free composition.
  * Sentences are short (<=70 chars), so windows come from within one sentence and a
    sentence yields at most a few windows (a window needs 51 usable keystrokes).
  * Collection conditions differ from Buffalo (domain shift).

Output (HDF5): windows (N, 50, 6) float32, participant (N,) int64 and section (N,) int64,
the TEST_SECTION_ID each window came from (-1 if it is not an integer). Windows of one
section overlap, so any split inside a participant must keep a section on one side.
Written in batches, so a full build does not need every window in memory.

Usage (inside the model-api container):
    # impostor set for keystroke_user_sweep.py (first 200 participants with >= 10 windows)
    python aalto_to_windows.py --src /app/data/Keystrokes/files \
        --out /app/data/aalto_impostors.h5 --max-participants 200
    # every participant, with a yield report
    python aalto_to_windows.py --src /app/data/Keystrokes/files \
        --out /app/data/aalto_all.h5 --max-participants 0 --min-windows 1 \
        --workers 4 --report /app/data/aalto_all_report.json
"""
import argparse
import glob
import json
import os
from multiprocessing import Pool

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
N_FEATURES = 6


def clamp01(v):
    if v != v:                                       # NaN, as JS clamp01 maps non-finite to 0
        return 0.0
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def keystroke_events(keystrokes):
    """[(press_ms, release_ms or None, keycode)] for ONE section -> the event stream a
    browser would have delivered: a keydown per keystroke and a keyup per known release,
    in time order. At equal times a keyup comes first (a key is released before it can go
    down again); otherwise the original keystroke order breaks ties. Returned as
    (time_ms, is_down, keycode)."""
    ev = []
    for i, (press, release, kc) in enumerate(keystrokes):
        ev.append((press, 1, i, kc))
        if release is not None:
            ev.append((release, 0, i, kc))
    ev.sort(key=lambda e: (e[0], e[1], e[2]))
    return [(t, is_down == 1, kc) for t, is_down, _, kc in ev]


def build_steps(keystrokes):
    """Port of eventSteps(): 6-feature digraph rows [id1, id2, dwell1, dwell2, dd, ud].

    A keyup is matched to the most recent unmatched keydown of the same key; consecutive
    keydowns form a digraph only when both have a keyup (a keystroke with no release stays
    in the sequence and pairs with neither neighbour, like a keydown without a keyup live).
    Impossible timings are dropped, then long gaps are dropped WITHOUT breaking the run, so
    the fluent typing either side is spliced together."""
    downs, ups, last_down = [], {}, {}
    for t, is_down, kc in keystroke_events(keystrokes):
        if is_down:
            last_down[kc] = len(downs)
            downs.append((t, kc))
        else:
            j = last_down.pop(kc, None)
            if j is not None:
                ups[j] = t

    raw = []
    for i in range(len(downs) - 1):
        if i not in ups or i + 1 not in ups:
            continue
        (p1, k1), (p2, k2) = downs[i], downs[i + 1]
        r1, r2 = ups[i], ups[i + 1]
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


def read_participant(path):
    """One Aalto participant file -> (participant_id, {section_id: [keystrokes]}, n_rows,
    n_no_release). Rows whose press time or key code cannot be read are dropped (live, an
    event without a finite time or key code is filtered out); a row whose release cannot
    be read keeps its keydown with no keyup."""
    sections, pid, n_rows, n_no_release = {}, None, 0, 0
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        header = f.readline().rstrip("\n").split("\t")
        idx = {name.strip().upper(): i for i, name in enumerate(header)}
        need = ("PARTICIPANT_ID", "TEST_SECTION_ID", "PRESS_TIME", "RELEASE_TIME", "KEYCODE")
        if not all(n in idx for n in need):
            return None, {}, 0, 0
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) <= idx["KEYCODE"]:
                continue
            try:
                row_pid = p[idx["PARTICIPANT_ID"]]
                sec = p[idx["TEST_SECTION_ID"]]
                press = float(p[idx["PRESS_TIME"]])
                kc = int(float(p[idx["KEYCODE"]]))
            except ValueError:
                continue
            if not np.isfinite(press) or press < 0:
                continue
            try:
                release = float(p[idx["RELEASE_TIME"]])
                if not np.isfinite(release) or release < 0:
                    release = None
            except ValueError:
                release = None
            n_rows += 1
            n_no_release += release is None
            pid = row_pid
            sections.setdefault(sec, []).append((press, release, kc))
    return pid, sections, n_rows, n_no_release


def section_number(sec):
    try:
        return int(sec)
    except ValueError:
        return -1


def participant_windows(path):
    """One Aalto participant file -> (participant_id, windows, section_ids, stats).

    Keystrokes are grouped by TEST_SECTION_ID: each section is one sentence typed as a
    continuous act. Concatenating across sections would invent a digraph spanning the
    gap between two unrelated sentences, so sections are kept apart."""
    pid, sections, n_rows, n_no_release = read_participant(path)
    wins, secs, with_window = [], [], 0
    for sec, keystrokes in sections.items():
        keystrokes.sort(key=lambda e: e[0])          # keystroke order = press time
        w = steps_to_windows(build_steps(keystrokes))
        wins.extend(w)
        secs.extend([section_number(sec)] * len(w))
        with_window += bool(w)
    stats = {"rows": n_rows, "no_release": n_no_release,
             "sections": len(sections), "sections_with_window": with_window}
    return pid, wins, secs, stats


class Appender:
    """Grows the three datasets in batches of whole participants."""

    def __init__(self, path, batch_windows=50_000):
        self.f = h5py.File(path, "w")
        self.w = self.f.create_dataset("windows", shape=(0, WINDOW_SIZE, N_FEATURES),
                                       maxshape=(None, WINDOW_SIZE, N_FEATURES), dtype="float32",
                                       chunks=(1024, WINDOW_SIZE, N_FEATURES), compression="gzip")
        self.p =self.f.create_dataset("participant", shape=(0,), maxshape=(None,),
                                       dtype="int64", chunks=(65536,), compression="gzip")
        self.s = self.f.create_dataset("section", shape=(0,), maxshape=(None,),
                                       dtype="int64", chunks=(65536,), compression="gzip")
        self.batch_windows = batch_windows
        self.buf_w, self.buf_p, self.buf_s = [], [], []
        self.n = 0

    def add(self, pid, wins, secs):
        self.buf_w.extend(wins)
        self.buf_p.extend([pid] * len(wins))
        self.buf_s.extend(secs)
        if len(self.buf_w) >= self.batch_windows:
            self.flush()

    def flush(self):
        if not self.buf_w:
            return
        k = len(self.buf_w)
        for ds, data in ((self.w, np.asarray(self.buf_w, dtype=np.float32)),
                         (self.p, np.asarray(self.buf_p, dtype=np.int64)),
                         (self.s, np.asarray(self.buf_s, dtype=np.int64))):
            ds.resize(self.n + k, axis=0)
            ds[self.n:self.n + k] = data
        self.n += k
        self.buf_w, self.buf_p, self.buf_s = [], [], []

    def close(self, attrs):
        self.flush()
        for key, value in attrs.items():
            self.f.attrs[key] = value
        self.f.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="dir containing *_keystrokes.txt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-participants", type=int, default=200,
                    help="stop after this many kept participants (0 = all)")
    ap.add_argument("--min-windows", type=int, default=10,
                    help="skip participants yielding fewer windows than this")
    ap.add_argument("--workers", type=int, default=1, help="parallel file readers")
    ap.add_argument("--report", help="write the yield report (JSON) here as well")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    files = sorted(glob.glob(os.path.join(args.src, "*_keystrokes.txt")))
    print(f"found {len(files)} participant files")
    if not files:
        raise SystemExit("no *_keystrokes.txt under --src")

    limit = args.max_participants if args.max_participants > 0 else None
    out = Appender(args.out)
    kept, scanned, no_header, below_min = 0, 0, 0, 0
    per_participant, kept_counts = [], []
    totals = {"rows": 0, "no_release": 0, "sections": 0, "sections_with_window": 0}
    pool = Pool(args.workers) if args.workers > 1 else None
    results = (pool.imap(participant_windows, files, chunksize=64) if pool
               else map(participant_windows, files))
    try:
        for pid, wins, secs, stats in results:
            scanned += 1
            for key in totals:
                totals[key] += stats[key]
            if pid is None:
                no_header += 1
                continue
            per_participant.append(len(wins))
            if len(wins) < args.min_windows:
                below_min += 1
                continue
            out.add(int(pid), wins, secs)
            kept_counts.append(len(wins))
            kept += 1
            if kept % 5000 == 0 or (limit and limit <= 1000 and kept % 25 == 0):
                print(f"  {kept} participants kept of {scanned} read, {out.n + len(out.buf_w)} windows")
            if limit and kept >= limit:
                break
    finally:
        if pool:
            pool.terminate()

    if not kept_counts:
        out.close({})
        raise SystemExit("no windows produced — check --src points at the files/ dir")

    counts = np.asarray(kept_counts)
    everyone = np.asarray(per_participant)
    report = {
        "files_found": len(files), "files_read": scanned, "no_usable_rows": no_header,
        "participants_read": int(everyone.size), "below_min_windows": below_min,
        "participants_kept": kept, "windows": int(counts.sum()),
        "min_windows": args.min_windows, "max_participants": args.max_participants,
        "keystroke_rows": totals["rows"], "rows_without_release": totals["no_release"],
        "sections": totals["sections"], "sections_with_a_window": totals["sections_with_window"],
        "windows_per_participant_read": {
            "zero": int((everyone == 0).sum()), "1-4": int(((everyone >= 1) & (everyone < 5)).sum()),
            "5-9": int(((everyone >= 5) & (everyone < 10)).sum()),
            "10-19": int(((everyone >= 10) & (everyone < 20)).sum()),
            "20+": int((everyone >= 20).sum()),
            "median": float(np.median(everyone)), "mean": round(float(everyone.mean()), 2)},
        "windows_per_participant_kept": {
            "min": int(counts.min()), "median": float(np.median(counts)), "max": int(counts.max())},
    }
    out.close({
        "source": "Aalto 136M keystrokes (Dhakal et al., CHI 2018)",
        "features": "id1,id2,dwell1,dwell2,dd,ud",
        "built_by": "aalto_to_windows.py (port of ca-service eventSteps)",
        "window_size": WINDOW_SIZE,
        "window_stride": WINDOW_STRIDE,
        "min_windows": args.min_windows,
        "max_participants": args.max_participants,
        "report": json.dumps(report),
    })
    print(f"participants kept={kept} (read {everyone.size}, below min {below_min}, "
          f"no usable rows {no_header})  windows={report['windows']}")
    print(f"per-participant windows (kept): min={counts.min()} median={int(np.median(counts))} "
          f"max={counts.max()}")
    print(f"sections with a window: {totals['sections_with_window']} of {totals['sections']}; "
          f"rows without a release: {totals['no_release']} of {totals['rows']}")
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
