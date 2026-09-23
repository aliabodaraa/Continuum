"""
Mechanical application of artifacts/repr_arch_study/PREREGISTRATION_D.md.

D1 = the adopted representation (|dx|, |dy| in pixels), re-used from Experiment B.
D2 = the same divided by each session's median step magnitude, so a constant per-device gain
     cannot separate people.
Primary endpoint: per-user window-level AUC on the test half, averaged over seeds, paired D2 - D1.

    python repr_device_analyze.py --arch B3
"""
import argparse
import glob
import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import repr_arch_analyze as RA                                     # noqa: E402

ROOT = "/app/artifacts/repr_arch_study"


def arm(pattern):
    docs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(ROOT, "parts", pattern)))]
    if len(docs) != 3:
        sys.exit(f"REFUSING: need 3 seeds for {pattern}, found {len(docs)}")
    return docs, RA.summarise_arm(docs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="B3")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    sha = hashlib.sha256(open(os.path.join(ROOT, "PREREGISTRATION_D.md"), "rb").read()).hexdigest()
    d1_docs, D1 = arm(f"B_{args.arch}_s*_A5.json")
    d2_docs, D2 = arm(f"B_{args.arch}_s*_D2.json")
    if any(d.get("sessionScale") != "medstep" for d in d2_docs):
        sys.exit("REFUSING: D2 parts were not produced with --scale medstep")
    users = sorted(set(D1["users"]) & set(D2["users"]))
    v = lambda S, k: [S[k][u] for u in users]
    print(f"pre-registration D {sha[:12]} | arch {args.arch} | {len(users)} targets")
    print(f"\n{'arm':<44}{'AUC':>7}{'medAUC':>8}{'EER%':>7}{'T@F1%':>7}{'CAP%':>7}{'top1':>7}")
    for name, S in ((f"D1 |dx|,|dy| (adopted)", D1), ("D2 same, per-session scale removed", D2)):
        f = lambda k: np.nanmean(v(S, k))
        print(f"{name:<44}{f('auc'):>7.3f}{np.nanmedian(v(S,'auc')):>8.3f}{f('eer')*100:>7.1f}"
              f"{f('tar01')*100:>7.1f}{f('cap')*100:>7.1f}{S['baseTop1']:>7.3f}")
    r = RA.boot(v(D1, "auc"), v(D2, "auc"))
    worse = r["meanDiff"] < 0 and r["p"] < 0.05
    print(f"\nprimary: D2 - D1 AUC {r['meanDiff']:+.4f} [{r['ci95'][0]:+.4f}, {r['ci95'][1]:+.4f}] "
          f"p {r['p']:.4f} (D2 higher for {r['bBetter']}/{r['n']} users)")
    if worse:
        print(f"-> device scale CONTRIBUTES: removing a constant per-session gain costs "
              f"{-r['meanDiff']:.4f} AUC. That is an upper bound on the part of our SapiMouse "
              f"accuracy that a same-device impostor would not face.")
    else:
        print("-> no significant drop: the accuracy does not rest on a constant per-device gain, "
              "so in that respect the SapiMouse estimate transfers to the same-device threat model.")
    extra = {k: RA.boot(v(D1, k), v(D2, k)) for k in ("eer", "tar01", "cap")}
    for k, x in extra.items():
        print(f"   {k}: {x['meanDiff']:+.4f} [{x['ci95'][0]:+.4f}, {x['ci95'][1]:+.4f}] p {x['p']:.4f}")
    out = {"preregistrationDSha256": sha, "arch": args.arch, "targets": users,
           "D1": {k: float(np.nanmean(v(D1, k))) for k in ("auc", "eer", "tar01", "cap")},
           "D2": {k: float(np.nanmean(v(D2, k))) for k in ("auc", "eer", "tar01", "cap")},
           "primary": r, "secondary": extra,
           "conclusion": "device scale contributes" if worse else "no significant device-scale effect"}
    path = os.path.join(ROOT, f"analysis_D_{args.arch}.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
