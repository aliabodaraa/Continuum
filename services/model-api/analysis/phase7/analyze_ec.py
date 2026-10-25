"""Experiment EC analysis (artifacts/phase7/PREREGISTRATION_EC.md section 3 and 4).

    python services/model-api/analysis/phase7/analyze_ec.py            # artifacts/phase7/ec_result.json / .txt
    python services/model-api/analysis/phase7/analyze_ec.py --smoke    # SMOKE TEST ONLY: reads ec/smoke

Decisions are step-disjoint blocks of 20 windows scored by their mean (packet_length_a200.decisions, as in paper
Table 4). Primary: the mean over owners of the per-user AUC at each enrolment size M. Paired differences to "all" come
with a 95% interval from a bootstrap over owners (10,000 resamples, seed 17). Saturation point: the smallest M whose
lower bound is above -0.005. Secondary: FAR/FRR at the live rule (10 of 20 below 0.50) pooled over owners, the share of
owners below a per-user AUC of 0.90, and the mean single-window EER. KS arm A200 is shown as the paper's reference.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase3")))
sys.path.insert(0, HERE)
import packet_length_a200 as PL  # noqa: E402
import run_ec as R  # noqa: E402

E = PL.E
N_DEC = 20
B, SEED, MARGIN, FLOOR = 10000, 17, -0.005, 0.90


def load(folder):
    users = []
    for f in sorted(glob.glob(os.path.join(folder, "*.json"))):
        x = json.load(open(f, encoding="utf-8"))
        if x.get("eligible"):
            users.append((x["participant"], np.asarray(x["genuine"], float), [np.asarray(v, float) for v in x["runs"].values()], x))
    return users


def per_size(users):
    dec = PL.decisions([(p, g, r) for p, g, r, _ in users], N_DEC)
    s = PL.summarise(dec)
    auc = {d["id"]: float(E.auc_fast(d["g"], d["i"])) for d in dec}
    weer = {p: float(E.eer_fast(g, np.concatenate(r))) for p, g, r, _ in users}
    return {"users": len(dec), "perUserAucMean": float(np.mean(list(auc.values()))), "far": s["far"], "frr": s["frr"],
            "pooledEer": s["eer"], "shareBelowFloor": float(np.mean([v < FLOOR for v in auc.values()])),
            "windowEerMean": float(np.mean(list(weer.values()))),
            "truncated": int(sum(bool(x.get("truncatedToBlock")) for *_, x in users)),
            "trainWindowsMean": float(np.mean([x["nTrain"] for *_, x in users])) if users and "nTrain" in users[0][3] else None,
            "_auc": auc}


def boot(diff):
    d = np.asarray(diff, float)
    idx = np.random.default_rng(SEED).integers(0, len(d), (B, len(d)))
    m = d[idx].mean(1)
    return {"mean": float(d.mean()), "lo": float(np.percentile(m, 2.5)), "hi": float(np.percentile(m, 97.5)),
            "higherFor": int((d > 0).sum()), "lowerFor": int((d < 0).sum()), "n": len(d)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    hashes = {} if a.smoke else R.verify_frozen()
    base = os.path.join(R.OUT, "smoke" if a.smoke else "parts")
    sizes = [s for s in R.SIZES if os.path.isdir(os.path.join(base, s))]
    res = {"hashes": hashes, "smokeTest": a.smoke, "sizes": {}, "paired": {}}
    for s in sizes:
        users = load(os.path.join(base, s))
        if not a.smoke:
            if len(users) != 99:
                raise SystemExit(f"size {s}: {len(users)} eligible owners, 99 expected (run not finished?)")
            if any(u[3].get("preregistrationEcSha256") != hashes["preregistrationEcSha256"] for u in users):
                raise SystemExit(f"size {s}: a part was written under another pre-registration")
        res["sizes"][s] = per_size(users)
    if "all" in res["sizes"]:
        ref = res["sizes"]["all"]["_auc"]
        for s in sizes:
            if s == "all":
                continue
            cur = res["sizes"][s]["_auc"]
            ids = sorted(set(cur) & set(ref))
            res["paired"][s] = boot([cur[i] - ref[i] for i in ids])
        sat = next((s for s in sizes if s != "all" and res["paired"][s]["lo"] > MARGIN), None)
        res["saturationPoint"] = sat
    ks = load(os.path.join(R.ROOT, "artifacts", "phase3", "parts", "A200"))
    if ks:
        k = per_size(ks)
        res["ksA200Reference"] = {x: k[x] for x in ("users", "perUserAucMean", "far", "frr", "pooledEer", "shareBelowFloor", "windowEerMean")}
        if "all" in res["sizes"]:
            ka, ea = k["_auc"], res["sizes"]["all"]["_auc"]
            ids = sorted(set(ka) & set(ea))
            res["allMinusKs"] = boot([ea[i] - ka[i] for i in ids])
    for s in res["sizes"]:
        res["sizes"][s].pop("_auc")
    out = os.path.join(R.ROOT, "artifacts", "phase7", "ec_smoke_result" if a.smoke else "ec_result")
    json.dump(res, open(out + ".json", "w", encoding="utf-8"), indent=1)
    L = [f"EXPERIMENT EC, typing enrolment learning curve ({'SMOKE TEST' if a.smoke else 'frozen run'}); "
         f"20-window decisions, block mean; FAR/FRR at 10 of 20 below 0.50"]
    for s in sizes:
        r = res["sizes"][s]
        p = res["paired"].get(s)
        L.append(f"  M={s:>4}: per-user AUC {r['perUserAucMean']:.4f}  FAR {r['far'] * 100:5.1f}%  FRR {r['frr'] * 100:5.1f}%  "
                 f"pooled EER {r['pooledEer'] * 100:5.2f}%  below {FLOOR}: {r['shareBelowFloor'] * 100:4.1f}%  window EER "
                 f"{r['windowEerMean'] * 100:5.2f}%  (owners {r['users']}, truncated {r['truncated']})"
                 + (f"  | vs all {p['mean']:+.4f} [{p['lo']:+.4f}, {p['hi']:+.4f}]" if p else ""))
    if "saturationPoint" in res:
        L.append(f"  saturation point (lower bound above {MARGIN}): {res['saturationPoint'] or 'none below all'}")
    if "ksA200Reference" in res:
        k = res["ksA200Reference"]
        L.append(f"  KS A200 (paper): per-user AUC {k['perUserAucMean']:.4f}  FAR {k['far'] * 100:5.1f}%  FRR {k['frr'] * 100:5.1f}%"
                 + (f"  | EC all minus KS {res['allMinusKs']['mean']:+.4f} [{res['allMinusKs']['lo']:+.4f}, {res['allMinusKs']['hi']:+.4f}]"
                    if "allMinusKs" in res else ""))
    txt = "\n".join(L)
    open(out + ".txt", "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
