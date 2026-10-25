"""Experiment SC analysis (artifacts/phase7/PREREGISTRATION_SC.md): the fine-tuned base (FT, the stored EC parts)
against the same network trained from scratch (SC), on the same owners, at M = 130 (primary) and M = all.

    python services/model-api/analysis/phase7/analyze_sc.py            # artifacts/phase7/sc_result.json / .txt
    python services/model-api/analysis/phase7/analyze_sc.py --smoke    # SMOKE TEST ONLY: reads sc/smoke

Per-user AUC of step-disjoint 20-window decisions scored by their mean, FAR/FRR at the deployed rule and the mean window
EER all come from analyze_ec.per_size, the code behind the EC result. FT minus SC is paired over the owners present in
both arms, with a 95% interval from analyze_ec.boot (10,000 resamples, seed 17).
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze_ec as AE  # noqa: E402
import run_sc as RS  # noqa: E402

OUT = os.path.join(RS.ROOT, "artifacts", "phase7")


def verdict(b):
    if b["lo"] > 0:
        return "the base helps"
    if b["hi"] < 0:
        return "scratch is better"
    return "no measurable difference"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    hashes = {} if a.smoke else RS.verify_frozen()
    sc_root = os.path.join(RS.OUT, "smoke" if a.smoke else "parts")
    ft_root = os.path.join(RS.ROOT, "artifacts", "phase7", "ec", "parts")
    res = {**hashes, "smokeTest": a.smoke, "sizes": {}}
    lines = [f"EXPERIMENT SC{' (SMOKE TEST)' if a.smoke else ''}: personal typing model, fine-tuned base (FT) vs trained "
             f"from scratch (SC), 20-window decisions"]
    for size in RS.SIZES:
        sc = AE.load(os.path.join(sc_root, size))
        ft = AE.load(os.path.join(ft_root, size))
        ids = sorted(set(p for p, *_ in sc) & set(p for p, *_ in ft))
        if not ids:
            continue
        sc_s = AE.per_size([u for u in sc if u[0] in ids])
        ft_s = AE.per_size([u for u in ft if u[0] in ids])
        diff = AE.boot([ft_s["_auc"][i] - sc_s["_auc"][i] for i in ids])
        epochs = [x["epochsRun"] for *_, x in sc if x["participant"] in ids]
        secs = [x.get("trainSeconds") for *_, x in sc if x["participant"] in ids and x.get("trainSeconds") is not None]
        ft_epochs = [x["epochsRun"] for *_, x in ft if x["participant"] in ids]
        row = {"owners": len(ids),
               "FT": {k: v for k, v in ft_s.items() if k != "_auc"}, "SC": {k: v for k, v in sc_s.items() if k != "_auc"},
               "ftMinusSc": diff, "verdict": verdict(diff),
               "epochsRun": {"FT": float(np.mean(ft_epochs)), "SC": float(np.mean(epochs))},
               "scTrainSecondsMean": float(np.mean(secs)) if secs else None,
               "perOwner": {str(i): {"FT": ft_s["_auc"][i], "SC": sc_s["_auc"][i]} for i in ids}}
        res["sizes"][size] = row
        lines.append(f"M={size:>4} ({len(ids)} owners): per-user AUC FT {ft_s['perUserAucMean']:.4f} vs SC {sc_s['perUserAucMean']:.4f}"
                     f" | FT-SC {diff['mean']:+.4f} [{diff['lo']:+.4f}, {diff['hi']:+.4f}], FT higher for {diff['higherFor']}/{diff['n']}"
                     f" -> {row['verdict']}")
        lines.append(f"          deployed rule FAR/FRR: FT {ft_s['far'] * 100:.1f}%/{ft_s['frr'] * 100:.1f}%, SC {sc_s['far'] * 100:.1f}%/"
                     f"{sc_s['frr'] * 100:.1f}% | window EER FT {ft_s['windowEerMean'] * 100:.1f}%, SC {sc_s['windowEerMean'] * 100:.1f}%"
                     f" | epochs FT {row['epochsRun']['FT']:.1f}, SC {row['epochsRun']['SC']:.1f}"
                     + (f", SC {row['scTrainSecondsMean']:.0f} s per owner" if row["scTrainSecondsMean"] else ""))
    name = "sc_smoke_result" if a.smoke else "sc_result"
    json.dump(res, open(os.path.join(OUT, name + ".json"), "w"), indent=1)
    txt = "\n".join(lines)
    open(os.path.join(OUT, name + ".txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
