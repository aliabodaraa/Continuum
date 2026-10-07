"""SPLIT_L (PREREGISTRATION_L.md section 4): base-val = 16 users drawn with default_rng(20260923) from
the base-training users of SPLIT_J that are eligible by window COUNTS alone (>= 440 windows in the 3-min
session and >= 150 in the 1-min session); base-train = the other base users. No score is read.

    python make_split_l.py   (run from services/model-api/analysis/phase2)
"""
import hashlib
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
STUDY = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "artifacts", "repr_arch_study"))
SPLIT_J = os.path.join(STUDY, "SPLIT_J.json")


def main(out=os.path.join(STUDY, "SPLIT_L.json")):
    s = json.load(open(SPLIT_J))
    base = sorted(s["baseTraining"], key=lambda u: int(u[4:]))
    c = s["counts"]
    eligible = [u for u in base if c[u]["enrol3min"] >= 440 and c[u]["test1min"] >= 150]
    rng = np.random.default_rng(20260923)
    val = sorted(rng.choice(eligible, 16, replace=False).tolist(), key=lambda u: int(u[4:]))
    train = [u for u in base if u not in val]
    doc = {"protocol": "L", "seed": 20260923,
           "splitJSha256": hashlib.sha256(open(SPLIT_J, "rb").read()).hexdigest(),
           "eligibility": {"enrol3minWindowsAtLeast": 440, "test1minWindowsAtLeast": 150},
           "eligibleBase": eligible, "baseVal": val, "baseTrain": train,
           "counts": {"base": len(base), "eligible": len(eligible), "baseVal": len(val), "baseTrain": len(train)}}
    json.dump(doc, open(out, "w"), indent=1)
    print(doc["counts"], "base-val:", ", ".join(val))


if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(STUDY, "SPLIT_L.json"))
