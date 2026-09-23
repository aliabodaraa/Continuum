"""
Deployed window pipeline vs Antal & Fejer's block method trained EXACTLY as
AFE_Project trains it, at matched seconds of session, on Continuum's task.

WHY THIS SUPERSEDES THE HARNESS COMPARISON
------------------------------------------
block_vs_window_matched_time.py put both representations through one shared
harness (global scaler, frozen extractor, small fitted head). That is
controlled, but it is not how either method is used: AFE_Project fine-tunes
the whole network per user, with per-block z-score scaling and its own
training schedule (antal2020_sweep.py --protocol afe). Under the harness the
block method scored far below what its own training achieves, so a
comparison there under-served it. Here each arm is scored by its OWN per-user
procedure:

  windows  the deployed pipeline: mouse-ws50-aligned base, per-user fine-tune
           via /api/user/train (mouse_population_sweep.py output)
  blocks   Antal & Fejer 2020 as released: MCDCNN, TRANSFER from an
           identification base, per-user training exactly as AFE_Project
           (antal2020_sweep.py --protocol afe output)

Same 20 held-out SapiMouse subjects in both, genuine material from each
target's 1-min session, impostors from the other held-out subjects' 1-min
sessions as contiguous runs. Enrolment is the one asymmetry and it favours
blocks: they enrol on the whole 3-min session, windows on the first 250
windows (~70 s of it).

MATCHED TIME
------------
The x-axis is seconds of the SAME session each arm consumes, measured from
the data rather than assumed: per subject, session movement-clock length /
steps and / blocks, median over subjects. A block costs more session time
than its own duration, because the events left over at the end of every
movement sequence never form a block. k windows consume 50 + 10(k-1) steps;
k blocks consume k block-costs. Units are averaged inside non-overlapping
groups (window groups are spaced k+4 apart so no two share a step), then
per-subject AUC and EER, then a paired bootstrap over subjects.

It also measures how much movement the deployed 20-window vote spans. The
windows overlap at stride 10, so 20 of them cover 240 steps, not 20 x 50.

Post-processing only; nothing is retrained.

    python block_vs_window_native.py \
        --blocks /app/artifacts/antal2020/sweep_afe.json \
        --out /app/artifacts/antal2020/block_vs_window_native.json
"""
import argparse
import json
import sys

import numpy as np

from keystroke_user_sweep import auc_of, eer_of
from preprocess_mouse import events_to_steps, _read_events
import mouse_population_sweep as mps

WS, STRIDE = 50, 10
VOTE_WINDOWS = 20            # ca-service/lib/mouse.js MOUSE_SUSTAIN_WINDOW


def groups(seq, k, stride):
    s = np.asarray(seq, float)
    return np.array([s[i:i + k].mean() for i in range(0, len(s) - k + 1, stride)])


def per_subject(rec, users, gen_key, imp_key, k, stride):
    out = {}
    for u in users:
        r = rec[u]
        g = groups(r[gen_key], k, stride)
        runs = [x for x in (groups(v, k, stride) for v in r[imp_key].values()) if len(x)]
        if len(g) < 2 or not runs:
            continue
        i = np.concatenate(runs)
        out[u] = (float(auc_of(g, i)), float(eer_of(g, i)[0]), int(len(g)), int(len(i)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--windows", default="/app/artifacts/mouse-ws50-aligned/population_scores.json")
    ap.add_argument("--blocks", default="/app/artifacts/antal2020/sweep_afe.json")
    ap.add_argument("--out", default="/app/artifacts/antal2020/block_vs_window_native.json")
    ap.add_argument("--max-blocks", type=int, default=5)
    args = ap.parse_args()

    win = {r["participant"]: r for r in json.load(open(args.windows))["perUser"]}
    blk = {"user%d" % r["subject"]: r for r in json.load(open(args.blocks))["perSubject"]}
    users = sorted(set(win) & set(blk), key=lambda u: int(u[4:]))

    # ---- time basis, measured on the test sessions themselves ----
    s_per_step, s_per_block, span1, span_vote = [], [], [], []
    span_n = WS + (VOTE_WINDOWS - 1) * STRIDE
    for u in users:
        _, short = mps.session_csvs(u)
        steps = events_to_steps(_read_events(short))
        dt = np.asarray([s[5] for s in steps], float)
        dur = float(dt.sum())                        # movement-clock length of the session
        s_per_step.append(dur / len(steps))
        s_per_block.append(dur / max(1, blk[u]["genuineBlocks"]))
        c = np.concatenate([[0.0], np.cumsum(dt)])
        span1 += [c[i + WS] - c[i] for i in range(0, len(dt) - WS + 1, STRIDE)]
        span_vote += [c[i + span_n] - c[i] for i in range(0, len(dt) - span_n + 1, STRIDE)]
    dt_step, block_s = float(np.median(s_per_step)), float(np.median(s_per_block))
    print(f"subjects {len(users)} | session time per step {dt_step:.4f}s, per block {block_s:.2f}s")
    print(f"one window: median {np.median(span1):.2f}s | the deployed {VOTE_WINDOWS}-window vote "
          f"({span_n} steps): median {np.median(span_vote):.2f}s "
          f"IQR {np.percentile(span_vote, 25):.2f}-{np.percentile(span_vote, 75):.2f}s "
          f"(summing {VOTE_WINDOWS} overlapping windows would say {VOTE_WINDOWS * np.median(span1):.1f}s)")

    rng = np.random.default_rng(0)
    print(f"\n{'T s':>6} | {'windows k  medAUC  medEER':<26} | {'blocks k  medAUC  medEER':<25} | "
          "paired AUC diff (windows - blocks)")
    rows = []
    for kb in range(1, args.max_blocks + 1):
        T = kb * block_s
        kw = max(1, int(round((T / dt_step - WS) / STRIDE)) + 1)
        W = per_subject(win, users, "_genuineScores", "_impostorRuns", kw, kw + WS // STRIDE - 1)
        B = per_subject(blk, users, "_genuine", "_impostorRuns", kb, kb)
        common = sorted(set(W) & set(B))
        wa = np.array([W[u][0] for u in common]); ba = np.array([B[u][0] for u in common])
        we = np.array([W[u][1] for u in common]); be = np.array([B[u][1] for u in common])
        d = wa - ba
        bs = d[rng.integers(0, len(d), (10000, len(d)))].mean(1)
        p = float(min(1.0, 2 * min((bs <= 0).mean(), (bs >= 0).mean())))
        ci = [float(x) for x in np.percentile(bs, [2.5, 97.5])]
        rows.append({"seconds": round(T, 2), "kWindows": kw, "kBlocks": kb, "n": len(common),
                     "windows": {"aucMedian": float(np.median(wa)), "aucMean": float(wa.mean()),
                                 "eerMedian": float(np.median(we)),
                                 "genuineGroupsMedian": int(np.median([W[u][2] for u in common]))},
                     "blocks": {"aucMedian": float(np.median(ba)), "aucMean": float(ba.mean()),
                                "eerMedian": float(np.median(be)),
                                "genuineGroupsMedian": int(np.median([B[u][2] for u in common]))},
                     "pairedAucDiffMean": float(d.mean()), "ci95": ci, "p": p,
                     "windowsBetter": int((d > 0).sum())})
        print(f"{T:>6.1f} | {kw:>4}w {np.median(wa):>7.3f} {np.median(we)*100:>6.1f}%      | "
              f"{kb:>3}b {np.median(ba):>7.3f} {np.median(be)*100:>6.1f}%      | "
              f"{d.mean():+.3f} [{ci[0]:+.3f},{ci[1]:+.3f}] p={p:.4f}  "
              f"windows better {int((d > 0).sum())}/{len(d)}")

    with open(args.out, "w") as f:
        json.dump({"question": "deployed windows vs Antal-Fejer blocks trained as AFE_Project, "
                               "matched session time, same subjects/sessions/impostors",
                   "windowsScores": args.windows, "blocksScores": args.blocks,
                   "timeBasis": {"secondsPerStep": dt_step, "secondsPerBlock": block_s,
                                 "oneWindowMedian": float(np.median(span1)),
                                 "voteWindows": VOTE_WINDOWS, "voteSteps": span_n,
                                 "voteSpanMedian": float(np.median(span_vote)),
                                 "voteSpanIQR": [float(np.percentile(span_vote, 25)),
                                                 float(np.percentile(span_vote, 75))]},
                   "enrolment": {"windows": "first 250 windows of the 3-min session",
                                 "blocks": "all blocks of the 3-min session"},
                   "byTime": rows}, f, indent=1)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    sys.exit(main())
