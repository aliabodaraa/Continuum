"""Protocol J, Phase P2: operating point and decision rule for the P1 method (PREREGISTRATION_J.md §6).

The section-5 search (percentile x rule x N, live cadence, <= 0.2 genuine prompts/min, most impostor
runs caught) re-run on the development calibration halves, identity order, with the method P1 adopted;
the point is frozen and reported on the development test halves. Reads parts/J_P1 only.

    python protocol_j_p2.py   ->  analysis_J_P2.json
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import protocol_j_common as J  # noqa: E402
import protocol_j_p1 as P1  # noqa: E402

OUT = os.path.join(J.STUDY, "analysis_J_P2.json")


def main():
    hashes = J.verify_frozen()
    p1 = json.load(open(P1.OUT))
    method = p1["adopted"]
    recs = [json.load(open(os.path.join(P1.PARTS, f))) for f in sorted(os.listdir(P1.PARTS)) if f.endswith(".json")]
    U = P1._units(recs, method, 0)
    op = P1._select(U)
    res = {u: J.per_user(h[1], float(np.percentile(src, op["q"])), op["rule"], op["n"], op["k"]) for u, (h, src) in U.items()}
    s = J.summary(res)
    out = {**hashes, "phase": "P2", "method": method, "operatingPoint": op, "testHalvesIdentityOrder": s,
           "perUser": {u: {k: v for k, v in r.items() if k not in ("caught", "times")} | {"runsCaught": float(np.mean(r["caught"]))}
                       for u, r in res.items()}}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"P2: method {method}, frozen point: {op['q']}th percentile, {op['rule']} n={op['n']} k={op['k']} (budget {op['budget']})")
    print(f"  calibration: prompts/min {op['cal']['promptsPerMinMean']:.2f}, runs caught {op['cal']['impostorRunsCaught']*100:.1f}%")
    print(f"  test halves: prompts/min mean {s['promptsPerMinMean']:.2f} median {s['promptsPerMinMedian']:.2f}, never prompted "
          f"{s['usersNeverPrompted']*100:.0f}%, runs caught {s['impostorRunsCaught']*100:.1f}%, time to catch {s['timeToCatchMedianS']:.1f} s")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
