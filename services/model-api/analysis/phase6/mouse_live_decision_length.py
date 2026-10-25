"""The live loop of the mouse channel at three decision lengths (TODO.md section 10, owner 2026-10-21: measure before a
console choice of the mouse decision length is added).

Protocol L stage D's stored F2 scores (19 development users, base-80 network, 440-window enrolment), the same source as
paper Table 6 and `mouse_decision_length.py`. The threshold stays each user's own (20th percentile of the
leave-one-sample-out scores). For N = 15, 33 and 60 windows the passkey is asked when at least K = ceil(0.55 N) of the
last N windows are low, as in the table. The live loop is `p1lib.replay` as in `f2_fixed_threshold.live_loop`: one check
every 6 new windows (the SDK's 1.6 s), the buffer empties after a request, the genuine stream is the user's test
session and each impostor run is another person's session. Reported, as means: genuine passkey requests per minute
of movement, the share of users never asked, the share of impostor runs caught and the time to the first request in a
caught run. Values are averaged over the stored variants, as in analyze_l.

    python analysis/phase6/mouse_live_decision_length.py   # artifacts/phase6/mouse_live_decision_length.json / .txt
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
import analyze_l as A  # noqa: E402
import p1lib as P  # noqa: E402

OUT = "/app/artifacts/phase6"
LENGTHS = (15, 33, 60)
CADENCE = 6


def live(U, targets, n, k):
    per = {}
    for u in targets:
        per[u] = P.per_user({"g": np.asarray(U[u]["genuine"], float),
                             "runs": {o: np.asarray(r, float) for o, r in U[u]["runs"].items()}},
                            U[u]["tau"], "vote", n, k, CADENCE)
    caught = [c for v in per.values() for c in v["caught"]]
    times = [t for v in per.values() for t in v["times"]]
    return {"promptsPerMinMean": float(np.nanmean([v["promptsPerMin"] for v in per.values()])),
            "usersNeverPrompted": float(np.mean([v["prompts"] == 0 for v in per.values()])),
            "impostorRunsCaught": float(np.mean(caught)) if caught else 0.0,
            "timeToCatchMeanS": float(np.mean(times)) if times else None,
            "genuineMinutes": float(sum(len(U[u]["genuine"]) for u in targets) * P.SEC_PER_WINDOW / 60.0),
            "impostorRuns": len(caught)}


def main():
    folder, path, d, hashes, V, code = A.load(False, None)
    targets = list(d["targets"])
    rows = []
    for n in LENGTHS:
        k = math.ceil(0.55 * n)
        per_variant = [live(U, targets, n, k) for U in V["F2"].values()]
        row = {"windows": n, "lowNeeded": k, "seconds": round((40 + 10 * n) * 0.0269, 1)}
        for key in per_variant[0]:
            vals = [p[key] for p in per_variant if p[key] is not None]
            row[key] = float(np.mean(vals)) if vals else None
        rows.append(row)
    res = {"source": path, "users": len(targets), "variants": len(V["F2"]), "checkEveryWindows": CADENCE,
           "threshold": "20th percentile of leave-one-sample-out scores", "rule": "passkey when >= ceil(0.55 N) of the last N are low",
           "rows": rows}
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "mouse_live_decision_length.json"), "w") as f:
        json.dump(res, f, indent=1)
    lines = [f"Mouse live loop, stage D F2, {len(targets)} users, {len(V['F2'])} variant(s), a check every {CADENCE} windows"]
    for r in rows:
        lines.append(f"{r['windows']:>3} windows ({r['lowNeeded']} low, first decision after about {r['seconds']:.0f} s): "
                     f"genuine requests {r['promptsPerMinMean']:.2f}/min, users never asked {r['usersNeverPrompted'] * 100:.0f}%, "
                     f"impostor runs caught {r['impostorRunsCaught'] * 100:.1f}%, mean time to catch {r['timeToCatchMeanS']:.1f} s")
    txt = "\n".join(lines)
    open(os.path.join(OUT, "mouse_live_decision_length.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
