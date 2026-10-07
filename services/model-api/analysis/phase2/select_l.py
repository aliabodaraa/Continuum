"""Protocol L selection (PREREGISTRATION_L.md section 4): score the four candidates on base-val, pick one.

    python select_l.py              # -> artifacts/phase2/L/selection_scores.json (reads base users only)

Per base-val target (16): enrolment = the first 440 windows of the 3-min session; genuine = the whole
1-min session; impostors = the other base-val users' first 150 windows of their 1-min session. The
per-user system is the F2-style head (l_common.score_targets), with the cohort = base-train. The score is
the mean per-user AUC of 9.9-s decisions (N = 33, pct). Ties within 0.002 go to ArcFace, then to the
smaller margin or temperature.

    python select_l.py --limit-targets 4     # SMOKE TEST ONLY: smoke models, writes under L/smoke/
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402

CANDIDATES = [("arcface", 0.20), ("arcface", 0.35), ("supcon", 0.07), ("supcon", 0.10)]
TIE = 0.002


def candidate_dir(root, obj, p):
    return os.path.join(root, f"{obj}-{p:g}-base-train-s101")


def choose(rows):
    """Highest mean per-user AUC; within TIE of the best: ArcFace first, then the smaller parameter."""
    top = max(r["meanPerUserAuc"] for r in rows)
    tied = sorted([r for r in rows if top - r["meanPerUserAuc"] <= TIE],
                  key=lambda r: (r["objective"] != "arcface", r["param"]))
    return tied[0]


def main(models_root=None, limit_targets=0):
    smoke = bool(limit_targets)
    hashes = LC.verify_frozen()
    folder = LC.SMOKE if smoke else LC.OUT
    path = os.path.join(folder, "selection_scores.json")
    if not smoke and os.path.exists(path):
        raise SystemExit(f"{path} exists already; selection is run once")
    j, l = LC.splits()
    val, train = l["baseVal"], l["baseTrain"]
    if smoke:
        val = val[:limit_targets]
    W = LC.Windows("selection")
    scale = LC.load_scaler()
    models_root = models_root or os.path.join(LC.SMOKE if smoke else LC.OUT, "models")
    rows = []
    for obj, p in CANDIDATES:
        d = candidate_dir(models_root, obj, p)
        if not os.path.exists(os.path.join(d, "meta.json")):
            raise SystemExit(f"missing candidate {d}")
        m, meta = LC.load_model_dir(d, allow_smoke=smoke)
        LC.check_hashes(meta, hashes, d)
        if meta["users"] != "base-train" or meta["seed"] != 101 or meta.get("fixedEpochs"):
            raise SystemExit(f"{d}: not a base-train, seed-101, early-stopped candidate")
        units = LC.score_targets(LC.embedder_from(m, scale), W, val, val, train)
        LC.check_finite(units, d)
        auc, _ = LC.per_user_auc(units)
        if not all(np.isfinite(v) for v in auc.values()):
            raise SystemExit(f"{d}: a base-val target has no per-user AUC ({[u for u, v in auc.items() if not np.isfinite(v)]})")
        rows.append({"objective": obj, "param": p, "model": os.path.basename(d), "bestEpoch": meta["bestEpoch"],
                     "weightsSha256": meta["weightsSha256"], "meanPerUserAuc": float(np.mean(list(auc.values()))),
                     "perUser": auc})
        print(f"[L-select] {obj} {p:g}: mean per-user AUC (9.9 s) {rows[-1]['meanPerUserAuc']:.4f} "
              f"(best epoch {meta['bestEpoch']})", flush=True)
    winner = choose(rows)
    out = {**hashes, "protocol": "L", "stage": "selection", "smokeTest": smoke, "baseVal": val, "cohort": "baseTrain",
           "candidates": rows,
           "winner": {k: winner[k] for k in ("objective", "param", "model", "bestEpoch", "weightsSha256", "meanPerUserAuc")},
           "tieRule": f"within {TIE} of the best: ArcFace first, then the smaller margin or temperature",
           "codeSha256": LC.code_hashes()}
    os.makedirs(folder, exist_ok=True)
    LC.write_json(path, out, indent=1)
    print(f"[L-select] winner: {winner['objective']} {winner['param']:g} (best epoch {winner['bestEpoch']}) -> {path}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-root", default=None)
    ap.add_argument("--limit-targets", type=int, default=0, help="SMOKE TEST ONLY")
    a = ap.parse_args()
    main(a.models_root, a.limit_targets)
