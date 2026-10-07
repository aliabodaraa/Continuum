"""
Population-scale enrollment sweep for the MOUSE modality.

Supersedes mouse_enroll_sweep_v2.py. That script's protocol was sound — targets
drawn from users the base model never saw, enrollment and test on different
sessions, impostor identities disjoint from targets and from the training
negatives — but it ran at N_TARGETS=5 / N_IMPOSTOR_USERS=5 and reported a MEAN
over a bimodal population. At budget 250 its five per-user EERs were
0.0 / 17.7 / 18.4 / 41.1 / 43.0 %, so the published 24.03% mean described no
user in the study (the median was 18.37%).

What changed here:
  * EVERY holdout user is a target, scored against every OTHER holdout user as
    an impostor identity — 20 targets x 19 impostor identities instead of 5 x 5.
  * Emits `_genuineScores` (temporal order) and `_impostorRuns`
    ({participant: contiguous score run}), the exact contract decision_sweep.py
    and analysis/{decision_paired,session_survival}.py already consume, so the
    whole keystroke decision-level toolchain applies to mouse unchanged.
  * Metric functions are IMPORTED from keystroke_user_sweep rather than
    reimplemented, so "EER" and "TAR@FAR=1%" mean the identical thing in both
    channels. Comparing the two is only legitimate if they are computed the
    same way.
  * Adds AUC and TAR@FAR=1% (never previously computed for mouse at any
    aggregation level) and reports median + IQR alongside the mean.
  * Cluster bootstrap over USERS — never over windows. Windows inside one
    session are correlated, so a window bootstrap reports an interval several
    times too narrow.

IMPOSTOR RUNS ARE CONTIGUOUS. Each impostor participant contributes one
unbroken block of windows taken in temporal order from their 1-min session.
They are never pooled across people and never thinned. Building packets from a
globally-pooled, thinned impostor set made consecutive "adjacent" windows come
from unrelated moments and inflated keystroke impostor capture from an honest
91.10% to a fictional 99.80% — an 8.7 point artefact. The same trap applies to
mouse and PACKET/vote analysis downstream depends on these runs being real.

Protocol (leakage-safe):
  targets             holdout users, from artifacts/<art>/holdout_users.json
  enrollment          3-min session, temporal order, first N windows
  genuine test        1-min session — different session, zero window overlap
  impostor test       other holdout users' 1-min sessions, contiguous runs
  training negatives  base users only, re-drawn per target
Targets, impostor identities and negative identities are three disjoint sets of
people, and none of them was seen by the identification base model.

NOTE on the reported EER: it is swept over the test scores, which is inherent to
EER as a summary. It is a threshold-independent CEILING, not the error rate the
deployed fixed-0.50 rule achieves. farAt050 / tarAt050 are the operating point.

NOTE on time scale: one window observes a median 1.20 s of motion. Per-window
numbers are NOT comparable with SapiMouse's 0.94 AUC (15 s) or Shen et al.'s
FAR 2.75% (10 min). Run decision_sweep.py on the output of this script to get
the aggregated, decision-level numbers that correspond to the deployed
15-of-20 sustained vote (~24 s).

Run inside the model-api container:
  python /app/services/model-api/mouse_population_sweep.py \
      --out /app/artifacts/mouse-ws50-gru/mouse_population_scores.json
"""
import argparse
import glob
import json
import os
import sys
import time
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402
from keystroke_user_sweep import LIVE_THRESHOLD, auc_of, eer_of, tar_at_far  # noqa: E402

MODEL_API = "http://localhost:5000"
DATA_DIR = os.getenv("SAPIMOUSE_DIR", "/app/data/sapimouse")
ART_DIR = os.getenv("SWEEP_ART_DIR", "/app/artifacts/mouse-ws50-gru")
BASE_MODEL = f"{ART_DIR}/best_model.h5"
SCALER = f"{ART_DIR}/scaler.json"

WS, STRIDE = 50, 10
OVERLAP_GAP = 5            # ceil(WS / STRIDE): windows closer than this share rows
IMP_RUN_LEN = 150          # contiguous windows scored per impostor participant
NEG_USERS = 30             # base users contributing to the negative pool
NEG_PER_USER = 40


def post(path, body, timeout=1800):
    req = urllib.request.Request(
        MODEL_API + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def session_csvs(uid):
    """(3-min csv, 1-min csv) for a user, or (None, None).

    Three users carry extra recordings — user35 and user62 have a second
    session five months after the first, user85 has an extra 5-min file. Taking
    the first match keeps one consistent (long, short) pair per user, which is
    what the base model was trained against.
    """
    csvs = sorted(glob.glob(os.path.join(DATA_DIR, uid, "*.csv")))
    long_s = [c for c in csvs if "3min" in os.path.basename(c)]
    short_s = [c for c in csvs if "1min" in os.path.basename(c)]
    return (long_s[0] if long_s else None), (short_s[0] if short_s else None)


def windows_of(csv):
    if csv is None:
        return np.empty((0, WS, 7), np.float32)
    return np.asarray(
        steps_to_windows(events_to_steps(_read_events(csv)), WS, STRIDE), np.float32)


def scores(windows, model_path):
    if len(windows) == 0:
        return np.array([])
    r = post("/api/user/predict", {
        "userId": "popsweep", "windows": np.asarray(windows).tolist(),
        "modelPath": model_path, "scalerPath": SCALER, "threshold": LIVE_THRESHOLD})
    return np.array([float(p[1]) for p in r.get("prediction", [])], dtype=float)


def cluster_boot(values, fn=np.median, n=2000, seed=7):
    """Percentile bootstrap resampling USERS (the independent unit), not windows."""
    v = np.asarray([x for x in values if x is not None and np.isfinite(x)], dtype=float)
    if len(v) < 2:
        return None
    rng = np.random.default_rng(seed)
    stat = [fn(v[rng.integers(0, len(v), len(v))]) for _ in range(n)]
    return [float(np.percentile(stat, 2.5)), float(np.percentile(stat, 97.5))]


def summarise(rows):
    def q(key):
        v = np.array([r[key] for r in rows if r.get(key) is not None], dtype=float)
        v = v[np.isfinite(v)]
        if not len(v):
            return None
        return {
            "mean": float(v.mean()), "median": float(np.median(v)),
            "iqr": [float(np.percentile(v, 25)), float(np.percentile(v, 75))],
            "p10": float(np.percentile(v, 10)), "p90": float(np.percentile(v, 90)),
            "min": float(v.min()), "max": float(v.max()), "std": float(v.std()),
            "ci95_median": cluster_boot([r.get(key) for r in rows]),
        }
    eer = np.array([r["eer"] for r in rows], dtype=float)
    return {
        "nUsers": len(rows),
        "eer": q("eer"), "auc": q("auc"),
        "farAt050": q("farAt050"), "tarAt050": q("tarAt050"),
        "tarAtFar01": q("tarAtFar01"), "tarAtFar05": q("tarAtFar05"),
        "usersWorseThan20pctEer": int((eer > 0.20).sum()),
        "usersWorseThan30pctEer": int((eer > 0.30).sum()),
        "usersBetterThan10pctEer": int((eer < 0.10).sum()),
    }


def main():
    ap = argparse.ArgumentParser(description="Population-scale mouse enrollment sweep")
    ap.add_argument("--out", default=f"{ART_DIR}/mouse_population_scores.json")
    ap.add_argument("--budget", type=int, default=250, help="enrollment windows per target")
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--limit", type=int, default=0, help="run only the first N targets (pilot)")
    args = ap.parse_args()

    with open(os.path.join(ART_DIR, "holdout_users.json")) as f:
        holdout = json.load(f)["holdout_users"]
    all_users = sorted(
        (os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*"))),
        key=lambda u: int("".join(c for c in u if c.isdigit()) or 0))
    base_users = [u for u in all_users if u not in holdout]

    # Negative pool: base users only — identities the target will never be tested
    # against, and which the base model was trained to identify.
    rng = np.random.default_rng(21)
    neg_parts = []
    for u in rng.choice(base_users, size=min(NEG_USERS, len(base_users)), replace=False):
        w = windows_of(session_csvs(u)[0])
        if len(w):
            neg_parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)), replace=False)])
    neg_pool = np.concatenate(neg_parts, axis=0)

    # Usable targets: holdout users with both sessions and enough enrollment data.
    # The IMPOSTOR pool is built separately and deliberately: a holdout user with
    # too little 3-min data to enrol as a target is still a perfectly good impostor
    # identity, and --limit must not shrink the impostor pool (a pilot would then
    # score each target against one person and report a meaningless FAR).
    usable, imp_candidates = [], []
    for u in holdout:
        long_s, short_s = session_csvs(u)
        if short_s is not None and len(windows_of(short_s)):
            imp_candidates.append(u)
        if long_s and short_s and len(windows_of(long_s)) >= args.budget and len(windows_of(short_s)):
            usable.append(u)
    targets = usable[:args.limit] if args.limit else usable

    print(f"holdout {len(holdout)} | usable targets {len(usable)} | running {len(targets)} "
          f"| impostor identities {len(imp_candidates)}")
    print(f"negative pool {neg_pool.shape} from {len(base_users)} base users")
    print(f"budget {args.budget} | epochs {args.epochs} | impostor run len {IMP_RUN_LEN}")
    print("targets, impostor identities and negative identities are disjoint sets\n")
    print(f"{'target':>9} {'enrol':>6} {'gen':>5} {'imps':>5} {'EER':>7} {'AUC':>6} "
          f"{'FAR@.5':>7} {'TAR@.5':>7} {'T@F1%':>7} {'secs':>6}")

    rows = []
    for uid in targets:
        t0 = time.time()
        long_s, short_s = session_csvs(uid)
        enroll = windows_of(long_s)[:args.budget]          # temporal order
        gen_test = windows_of(short_s)                      # different session

        negs = neg_pool[rng.choice(len(neg_pool), size=min(2 * args.budget, len(neg_pool)),
                                   replace=False)]
        model_path = f"/app/artifacts/users/popsweep-{uid}/mouse_model"
        post("/api/user/train", {
            "userId": f"popsweep-{uid}",
            "positiveWindows": enroll.tolist(),
            "negativeWindows": negs.tolist(),
            "overlapGap": OVERLAP_GAP,
            "minPositiveWindows": 12,
            "modelPath": model_path, "scalerPath": SCALER,
            "baseModelPath": BASE_MODEL,
            "epochs": args.epochs, "batchSize": 32})

        g = scores(gen_test, model_path)

        # One CONTIGUOUS run per impostor identity — never pooled, never thinned.
        imp_runs = {}
        for other in imp_candidates:
            if other == uid:
                continue
            w = windows_of(session_csvs(other)[1])[:IMP_RUN_LEN]
            if len(w):
                imp_runs[other] = scores(w, model_path).tolist()
        i = np.concatenate([np.asarray(r) for r in imp_runs.values()]) if imp_runs else np.array([])

        if not len(g) or not len(i):
            print(f"{uid:>9}   skipped (no genuine or impostor windows)")
            continue

        eer, _ = eer_of(g, i)
        row = {
            "participant": uid,
            "enrolWindows": int(len(enroll)),
            "genuineWindows": int(len(g)),
            "impostorParticipants": len(imp_runs),
            "impostorWindows": int(len(i)),
            "eer": float(eer),
            "auc": float(auc_of(g, i)),
            "farAt050": float((i >= LIVE_THRESHOLD).mean()),
            "tarAt050": float((g >= LIVE_THRESHOLD).mean()),
            "tarAtFar01": float(tar_at_far(g, i, 0.01)[0]),
            "tarAtFar05": float(tar_at_far(g, i, 0.05)[0]),
            "genuineMean": float(g.mean()), "impostorMean": float(i.mean()),
            "_genuineScores": g.tolist(),          # temporal order
            "_impostorRuns": imp_runs,             # {participant: contiguous run}
        }
        rows.append(row)
        print(f"{uid:>9} {len(enroll):>6} {len(g):>5} {len(imp_runs):>5} "
              f"{row['eer']:>6.2%} {row['auc']:>6.3f} {row['farAt050']:>6.2%} "
              f"{row['tarAt050']:>6.2%} {row['tarAtFar01']:>6.2%} {time.time()-t0:>6.1f}")

        # Checkpoint every target: these sweeps have been killed by Docker restarts.
        with open(args.out, "w") as f:
            json.dump({"perUser": rows, "summary": summarise(rows), "partial": True,
                       "config": {"budget": args.budget, "epochs": args.epochs,
                                  "baseModel": BASE_MODEL, "impRunLen": IMP_RUN_LEN}}, f)

    s = summarise(rows)
    with open(args.out, "w") as f:
        json.dump({"perUser": rows, "summary": s,
                   "config": {"budget": args.budget, "epochs": args.epochs,
                              "baseModel": BASE_MODEL, "impRunLen": IMP_RUN_LEN}}, f)

    print("\n" + "=" * 78)
    print(f"MOUSE POPULATION  n={s['nUsers']}  budget={args.budget}  base={os.path.basename(ART_DIR)}")
    print("=" * 78)
    for k, label in (("eer", "EER"), ("auc", "AUC"), ("tarAtFar01", "TAR@FAR=1%"),
                     ("farAt050", "FAR@0.50"), ("tarAt050", "TAR@0.50")):
        q = s[k]
        if not q:
            continue
        ci = q["ci95_median"]
        ci_s = f"  CI[{ci[0]:.4f}, {ci[1]:.4f}]" if ci else ""
        print(f"  {label:<11} median {q['median']:.4f}  IQR {q['iqr'][0]:.4f}-{q['iqr'][1]:.4f}  "
              f"min {q['min']:.4f}  max {q['max']:.4f}{ci_s}")
    print(f"\n  users with EER < 10%: {s['usersBetterThan10pctEer']}/{s['nUsers']}")
    print(f"  users with EER > 20%: {s['usersWorseThan20pctEer']}/{s['nUsers']}")
    print(f"  users with EER > 30%: {s['usersWorseThan30pctEer']}/{s['nUsers']}")
    print(f"\nwrote {args.out}")
    print("NEXT: python decision_sweep.py --scores "
          f"{args.out} --out {os.path.dirname(args.out)}/mouse_decision_sweep.json")


if __name__ == "__main__":
    main()
