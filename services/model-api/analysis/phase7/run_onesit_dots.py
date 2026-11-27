"""One-sitting enrolment check, second amendment (27 Nov 2026): COORDINATION.md commit 7a0e2cc, fixed before any number
of this file was computed.

The owner's objection: "on the dots-only pad I entered my samples and it accepted me". Was it the dots, or the days his
samples were spread over? Arms, each built as the others (run_ru.build):
    D1  his six dot-pad samples of 13 Sep 21:29-21:30 (27-32), one sitting
    A6  the newest six samples of A (35, 37, 136, 205, 206, 239): the same pad over four days, the same count
    T6  the last six samples of T (304-309): the task pad in one sitting, the same count
    A, M, T  as in run_onesit.py (their thresholds must equal artifacts/phase7/onesit_result.json)
Read on his 558 checks of 22-24 Nov (replay as in RU), on the 20 held-out SapiMouse users and on the 10 Balabit users as
in run_onesit_q3.py, raw and scaled to A's median step.
Reading: "one sitting of dots accepts him" when D1's requests per minute are not above A6's; "and it knows him" when
D1's capture is also within 5 points of A6's on both impostor sets, raw and scaled.

    docker run --rm -m 6g -v <repo>:/repo -v <private dir>:/data:ro -w /repo continuum/model-api:local \
        python /repo/services/model-api/analysis/phase7/run_onesit_dots.py --old /data/owner_mouse_2026-11-24.json \
        --new /data/owner_mouse_2026-11-25.json --today /data/owner_mouse_2026-11-27.json \
        --balabit /repo/data/balabit/training_files --out /repo/artifacts/phase7
"""
import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_ru as RU  # noqa: E402
import run_onesit as OS  # noqa: E402
import run_onesit_q3 as Q3  # noqa: E402

D1_IDS = [27, 28, 29, 30, 31, 32]
A6_IDS = [35, 37, 136, 205, 206, 239]
T6_IDS = [304, 305, 306, 307, 308, 309]
MARGIN = -5.0
FIRST = "artifacts/phase7/onesit_result.json"


def main():
    ap = argparse.ArgumentParser()
    for k in ("old", "new", "today", "balabit", "out"):
        ap.add_argument("--" + k, required=True)
    a = ap.parse_args()
    t0 = time.time()
    old, new, today = (json.load(open(p, encoding="utf-8")) for p in (a.old, a.new, a.today))
    samples, made = {}, {}
    for ex in (old, new, today):
        samples.update({s["id"]: s["windows"] for s in ex["samples"]})
        made.update({s["id"]: str(s["created_at"])[:16] for s in ex["samples"]})
    cat = lambda ids: np.concatenate([np.asarray(samples[i], np.float32) for i in ids])  # noqa: E731
    step = lambda ids: float(np.median(np.hypot(cat(ids)[..., 0], cat(ids)[..., 1])))  # noqa: E731

    sets = (("A", OS.A_IDS), ("M", OS.M_IDS), ("T", OS.T_IDS), ("D1", D1_IDS), ("A6", A6_IDS), ("T6", T6_IDS))
    arms = {k: RU.build(cat(ids)) for k, ids in sets}
    first = json.load(open(FIRST, encoding="utf-8"))["thresholds"]
    v_th = {k: abs(arms[k]["threshold"] - first[k]) for k in ("A", "M", "T")}
    valid = all(x < 1e-9 for x in v_th.values())

    # ---- genuine: his 558 checks of 22-24 Nov
    olds = sorted(old["checks"], key=lambda c: int(c["decision_id"]))
    sc = RU.Scorer()
    k_old = [sc.add(c["windows"]) for c in olds]
    sc.embed()
    win = {k: sc.scores(arm["head"]) for k, arm in arms.items()}
    segs, _ = RU.segments(olds, k_old)
    minutes = sum(1 for c in olds if not c["warmup"]) * RU.SEC_PER_CHECK / 60
    gidx = np.unique(np.concatenate([np.asarray(k) for k in k_old]))
    G = {}
    for k, arm in arms.items():
        asked = RU.replay(segs, win[k], arm["threshold"])
        low = [int((win[k][np.asarray(kk)] < arm["threshold"]).sum()) for kk in k_old]
        G[k] = {"threshold": arm["threshold"], "requests": len(asked), "perMin": len(asked) / minutes,
                "meanLowOf60": float(np.mean(low)), "realUseMedianScore": float(np.median(win[k][gidx]))}

    # ---- impostors: SapiMouse (game) and Balabit (free use)
    own_med = step(OS.A_IDS)
    sapi = RU.impostor_data(own_med)
    bal = {}
    for u, X in Q3.balabit_windows(a.balabit).items():
        med = float(np.median(np.hypot(X[..., 0], X[..., 1]))) if len(X) else 0.0
        bal[u] = {"raw": X, "scaled": np.round(X * (own_med / med if med > 0 else 1.0)).astype(np.float32)}
    I = {}
    for name, imp in (("sapimouse", sapi), ("balabit", bal)):
        isc = RU.Scorer()
        ikeys = {u: {v: isc.add(dd[v]) for v in ("raw", "scaled")} for u, dd in imp.items()}
        isc.embed()
        iwin = {k: isc.scores(arm["head"]) for k, arm in arms.items()}
        per = {k: {v: {u: RU.disjoint_caught(iwin[k][np.asarray(ikeys[u][v])], arms[k]["threshold"]) for u in imp}
                   for v in ("raw", "scaled")} for k in arms}
        I[name] = {"capture": {k: {v: 100 * sum(sum(x) for x in per[k][v].values()) / sum(len(x) for x in per[k][v].values())
                                   for v in ("raw", "scaled")} for k in arms},
                   "aucHisUseVsThem": {k: {v: OS.auc(win[k][gidx], np.concatenate([iwin[k][np.asarray(ikeys[u][v])] for u in imp]))
                                           for v in ("raw", "scaled")} for k in arms},
                   "D1_vs_A6": {v: dict(zip(("deltaPoints", "lo", "hi"), RU.users_ci(per["A6"][v], per["D1"][v])[:3])) for v in ("raw", "scaled")},
                   "T6_vs_A6": {v: dict(zip(("deltaPoints", "lo", "hi"), RU.users_ci(per["A6"][v], per["T6"][v])[:3])) for v in ("raw", "scaled")}}

    accepts = G["D1"]["perMin"] <= G["A6"]["perMin"]
    knows = all(I[n]["D1_vs_A6"][v]["deltaPoints"] >= MARGIN for n in I for v in ("raw", "scaled"))
    verdict = {"oneSittingOfDotsAcceptsHim": bool(valid and accepts), "andItKnowsHim": bool(valid and accepts and knows)}

    code = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()
    res = {"code": code, "seconds": round(time.time() - t0, 1), "valid": valid, "thresholdsVsFirstRun": v_th,
           "sets": {k: {"ids": ids, "made": sorted({made[i][:10] for i in ids}), "medianStepPx": step(ids)} for k, ids in sets},
           "minutes": minutes, "genuine": G, "impostors": I, "verdict": verdict}
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "onesit_dots_result.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1)
    L = [f"Dots or days, code {code[:12]}, valid {valid}; {res['seconds']} s; his 558 checks = {minutes:.1f} min of movement"]
    for k, ids in sets:
        g, s, b = G[k], I["sapimouse"], I["balabit"]
        L.append(f"  {k:<3} {len(ids)} samples on {len(res['sets'][k]['made'])} day(s), median step {res['sets'][k]['medianStepPx']:.1f} px, threshold {g['threshold']:.4f}: "
                 f"{g['requests']:>3} requests ({g['perMin']:.2f}/min), mean low {g['meanLowOf60']:.1f} of 60, real-use median score {g['realUseMedianScore']:.3f} | "
                 f"SapiMouse {s['capture'][k]['raw']:.1f}/{s['capture'][k]['scaled']:.1f}% | Balabit {b['capture'][k]['raw']:.1f}/{b['capture'][k]['scaled']:.1f}% "
                 f"(AUC his use vs Balabit {b['aucHisUseVsThem'][k]['raw']:.3f}/{b['aucHisUseVsThem'][k]['scaled']:.3f})")
    for n in I:
        for pair in ("D1_vs_A6", "T6_vs_A6"):
            x = I[n][pair]
            L.append(f"{n} {pair}: raw {x['raw']['deltaPoints']:+.1f} [{x['raw']['lo']:+.1f}, {x['raw']['hi']:+.1f}], "
                     f"scaled {x['scaled']['deltaPoints']:+.1f} [{x['scaled']['lo']:+.1f}, {x['scaled']['hi']:+.1f}]")
    L.append(f"verdict: {json.dumps(verdict)}")
    txt = "\n".join(L)
    open(os.path.join(a.out, "onesit_dots_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
