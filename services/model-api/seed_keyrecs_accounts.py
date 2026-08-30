"""
Turn KeyRecs participants into real Continuum accounts.

Why reconstruct events instead of injecting features
----------------------------------------------------
KeyRecs ships digraph FEATURES (key1, key2, DU, DD, UD, UU). The live system stores raw
keydown/keyup EVENTS and derives features itself via buildSteps(). Injecting features
somewhere in the middle would create accounts that never pass through the real pipeline, so
they would prove nothing about the pipeline.

Instead this rebuilds an absolute-time event stream that, when fed through the ordinary
buildSteps() path, reproduces the original digraphs. With press(key_0) at t=0:

    release(key_i) = press(key_i) + DU.key1.key1_i        (dwell of the first key)
    press(key_i+1) = press(key_i) + DD.key1.key2_i        (down-down latency)
    release(last)  = press(last)  + (UU - UD)             (dwell of the second key)

Rows are emitted as-is; the pipeline applies its own filters (impossible timings,
sub-human dwell/latency, >1s composition pauses), exactly as it would for a live typist.
A row whose key name has no keycode, or where the chain breaks (key2 of one row is not key1
of the next), ends the run and starts a new one rather than being silently spliced.

Which participants
------------------
Only the frozen NEGATIVE pool (sorted participant ids [0:40]). The frozen evaluation draws
impostors from [40:80], with [80:99] held in reserve; seeding those would put a model's own
evaluation impostors into its training negatives, contaminating the headline figures that
paper/BASELINE.md pins. Participants [0:40] are the cohort the system is already allowed to
learn from, so promoting them to accounts changes nothing about the frozen protocol.

Output is JSON for the inserter; this script writes no database.

Usage (inside the model-api container):
    python seed_keyrecs_accounts.py --out /tmp/keyrecs_accounts.json
"""
import argparse
import csv
import json
from collections import defaultdict

from keyrecs_to_windows import keycode_of

# readable text reconstruction
CODE_TO_CHAR = {32: " ", 13: "\n", 9: "\t"}
SKIP_IN_TEXT = {16, 17, 18, 20, 27, 91, 37, 38, 39, 40, 33, 34, 35, 36}


def code_to_char(code):
    if code in CODE_TO_CHAR:
        return CODE_TO_CHAR[code]
    if code == 8:                       # backspace: show nothing, it is an edit
        return ""
    if code in SKIP_IN_TEXT:
        return ""
    if 65 <= code <= 90:
        return chr(code).lower()
    if 48 <= code <= 57:
        return chr(code)
    return ""


def runs_for_participant(rows):
    """Contiguous chains of digraphs -> absolute-time key events.

    Returns a list of runs; each run is a list of (keycode, press_ms, release_ms)."""
    runs, cur, t = [], [], 0.0
    prev_k2 = None
    for r in rows:
        k1, k2 = keycode_of(r["key1"]), keycode_of(r["key2"])
        try:
            dwell1 = float(r["DU.key1.key1"])
            dd = float(r["DD.key1.key2"])
            ud = float(r["UD.key1.key2"])
            uu = float(r["UU.key1.key2"])
        except (KeyError, TypeError, ValueError):
            k1 = None
        if k1 is None or k2 is None or dd <= 0 or dwell1 < 0:
            if len(cur) > 1:
                runs.append(cur)
            cur, prev_k2, t = [], None, 0.0
            continue
        if prev_k2 is not None and k1 != prev_k2:
            # chain broken: this row does not continue the previous one
            if len(cur) > 1:
                runs.append(cur)
            cur, t = [], 0.0
        if not cur:
            cur.append((k1, t, t + dwell1))
        t_next = t + dd
        cur.append((k2, t_next, t_next + max(uu - ud, 0.001)))
        # the next row's key1 dwell overrides this provisional release
        t, prev_k2 = t_next, k2
        cur[-1] = (k2, t_next, t_next + max(uu - ud, 0.001))
    if len(cur) > 1:
        runs.append(cur)
    return runs


def chunk(run, size):
    for i in range(0, len(run), size):
        part = run[i:i + size]
        if len(part) >= 60:                      # needs > WINDOW_SIZE digraphs to be useful
            yield part


def to_sample(part):
    """One stored sample: reconstructed text plus its keydown/keyup events."""
    base = part[0][1]
    events, text = [], []
    for code, press, release in part:
        events.append({"keyCode": code, "eventType": "keydown",
                       "timestampRelative": round((press - base) * 1000.0, 3)})
        events.append({"keyCode": code, "eventType": "keyup",
                       "timestampRelative": round((release - base) * 1000.0, 3)})
        text.append(code_to_char(code))
    events.sort(key=lambda e: (e["timestampRelative"],
                               0 if e["eventType"] == "keydown" else 1))
    return {"text": "".join(text).strip(), "events": events}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/app/data/keyrecs/free-text.csv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--count", type=int, default=40)
    ap.add_argument("--chunk", type=int, default=300, help="digraphs per stored sample")
    ap.add_argument("--min-samples", type=int, default=8)
    ap.add_argument("--min-train", type=int, default=5)   # MIN_TRAINING_SAMPLES in ca-service
    ap.add_argument("--max-train", type=int, default=20)
    args = ap.parse_args()

    by_participant = defaultdict(list)
    with open(args.src, newline="") as f:
        reader = csv.DictReader(f)
        # The shipped header has a trailing space on the last column ("UU.key1.key2 "), so
        # every lookup of the clean name raises KeyError. Strip the field names once here.
        reader.fieldnames = [(n or "").strip() for n in reader.fieldnames]
        for row in reader:
            by_participant[row["participant"].strip()].append(row)

    ids = sorted(by_participant)
    chosen = ids[:args.count]              # the frozen NEGATIVE pool, see module docstring
    print(f"{len(ids)} participants in corpus; seeding the first {len(chosen)} "
          f"(frozen negative pool — impostor pool [40:80] left untouched)")

    accounts = []
    for pid in chosen:
        runs = runs_for_participant(by_participant[pid])
        parts = [p for run in runs for p in chunk(run, args.chunk)]
        # Use everything the participant has, split 70/30 in TIME (training first), rather
        # than a fixed sample count. Each stored sample loses 50 digraphs to the window
        # length, so a few large samples yield far more windows than many small ones, and
        # real users differ in how much they have typed anyway.
        if len(parts) < args.min_samples:
            print(f"  {pid}: only {len(parts)} usable samples, skipping")
            continue
        cut = max(args.min_train, int(len(parts) * 0.7))
        train = [to_sample(p) for p in parts[:min(cut, args.max_train)]]
        held = [to_sample(p) for p in parts[cut:]]
        if len(train) < args.min_train or len(held) < 2:
            print(f"  {pid}: {len(train)} train / {len(held)} held-out after split, skipping")
            continue
        accounts.append({
            "participant": pid,
            "username": f"keyrecs-{pid}",
            "training": train,
            "heldOut": held,
            "nTrainEvents": sum(len(s["events"]) for s in train),
        })
        print(f"  {pid}: {len(train)} training + {len(held)} held-out samples, "
              f"{accounts[-1]['nTrainEvents']} training events")

    with open(args.out, "w") as f:
        json.dump({"source": "KeyRecs (Dias et al., Data in Brief 2023, CC-BY 4.0, "
                             "doi:10.5281/zenodo.7886742)",
                   "note": "reconstructed keydown/keyup streams; features are re-derived by "
                           "the live pipeline, not injected",
                   "accounts": accounts}, f)
    print(f"\nwrote {args.out}: {len(accounts)} accounts")


if __name__ == "__main__":
    main()
