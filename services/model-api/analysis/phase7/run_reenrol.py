"""Re-enrolment check (25 Nov 2026): the comparison fixed in COORDINATION.md (commit 098e4bb) before this file was written.

The owner re-enrolled his mouse on 25 Nov (samples 290-297), and the new profile N (threshold 0.79) asked for his
passkey at its fourth check. Three profiles, each built as api.train_user_f2_payload builds it (run_ru.build):
    A  his old profile: samples 32, 33, 35, 37, 136, 205, 206, 239
    N  the new profile, live since 25 Nov 07:18 UTC: samples 290-297
    M  a mix: samples 294-297 then 136, 205, 206, 239 (the order the service builds once the old four are stored again)
Genuine side: his 558 checks of 22-24 Nov replayed as in RU, and the 5 checks since N went live. Impostor side: the 20
held-out SapiMouse users, disjoint 60-window decisions, raw and scaled to his median step over A's windows.
Rule: N or M is acceptable when its requests per minute on his real use are below A's and its capture is not lower than
A's by more than 5 points, raw and scaled; of two acceptable ones, the one with fewer requests.

Reads two private exports (kept outside the repository) and writes only aggregates:
    docker run --rm -m 6g -v <repo>:/repo -v <private dir>:/data:ro -w /repo continuum/model-api:local \
        python /repo/services/model-api/analysis/phase7/run_reenrol.py --old /data/owner_mouse_2026-11-24.json \
        --new /data/owner_mouse_2026-11-25.json --out /repo/artifacts/phase7
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
import run_ru as RU  # noqa: E402  build, Scorer, segments, replay, impostor_data, disjoint_caught, users_ci

A_IDS = [32, 33, 35, 37, 136, 205, 206, 239]
N_IDS = [290, 291, 292, 293, 294, 295, 296, 297]
M_IDS = [294, 295, 296, 297, 136, 205, 206, 239]
A_TH, N_TH = 0.26208394455013234, 0.7902170168193853
MARGIN = -5.0


def stored(c):
    return np.array([float(x[1]) if isinstance(x, list) else float(x) for x in c["scores"]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    t0 = time.time()
    old, new = json.load(open(a.old, encoding="utf-8")), json.load(open(a.new, encoding="utf-8"))
    samples = {s["id"]: s["windows"] for s in old["samples"]}
    samples.update({s["id"]: s["windows"] for s in new["samples"]})

    arms = {}
    for name, ids in (("A", A_IDS), ("N", N_IDS), ("M", M_IDS)):
        arms[name] = RU.build(np.concatenate([np.asarray(samples[i], np.float32) for i in ids]))
    v1 = {"A": abs(arms["A"]["threshold"] - A_TH), "N": abs(arms["N"]["threshold"] - N_TH)}

    # ---- genuine: his checks of 22-24 Nov, and the checks since N went live
    olds = sorted(old["checks"], key=lambda c: int(c["decision_id"]))
    news = sorted(new["checks"], key=lambda c: int(c["decision_id"]))
    sc = RU.Scorer()
    k_old = [sc.add(c["windows"]) for c in olds]
    k_new = [sc.add(c["windows"]) for c in news]
    sc.embed()
    win = {k: sc.scores(arm["head"]) for k, arm in arms.items()}
    v2 = {"A": max(float(np.max(np.abs(win["A"][np.asarray(k)] - stored(c)))) for k, c in zip(k_old, olds) if len(c["scores"]) == len(k)),
          "N": max(float(np.max(np.abs(win["N"][np.asarray(k)] - stored(c)))) for k, c in zip(k_new, news) if len(c["scores"]) == len(k))}
    nonwarm = [c for c in olds if not c["warmup"]]
    minutes = len(nonwarm) * RU.SEC_PER_CHECK / 60
    segs, _ = RU.segments(olds, k_old)
    genuine = {"checks": len(olds), "nonWarmupChecks": len(nonwarm), "minutes": minutes, "segments": len(segs),
               "liveRequestsUnderA": sum(1 for c in olds if c["suspicious"] and not c["warmup"]), "arms": {}}
    for k, arm in arms.items():
        asked = RU.replay(segs, win[k], arm["threshold"])
        low = [int((win[k][np.asarray(kk)] < arm["threshold"]).sum()) for kk in k_old]
        genuine["arms"][k] = {"threshold": arm["threshold"], "requests": len(asked), "perMin": len(asked) / minutes,
                              "checksAt33": sum(1 for x in low if x >= RU.K), "meanLow": float(np.mean(low)),
                              "sinceNLive": [int((win[k][np.asarray(kk)] < arm["threshold"]).sum()) for kk in k_new]}

    # ---- impostors
    PA = np.concatenate([np.asarray(samples[i], np.float32) for i in A_IDS])
    own_med = float(np.median(np.hypot(PA[..., 0], PA[..., 1])))
    imp = RU.impostor_data(own_med)
    isc = RU.Scorer()
    ikeys = {u: {v: isc.add(d[v]) for v in ("raw", "scaled")} for u, d in imp.items()}
    isc.embed()
    iwin = {k: isc.scores(arm["head"]) for k, arm in arms.items()}
    I = {}
    for v in ("raw", "scaled"):
        per = {k: {u: RU.disjoint_caught(iwin[k][np.asarray(ikeys[u][v])], arms[k]["threshold"]) for u in imp} for k in arms}
        I[v] = {}
        for k in ("N", "M"):
            point, lo, hi, ca, cb, n = RU.users_ci(per["A"], per[k])
            I[v][k] = {"captureA": ca, "capture": cb, "deltaPoints": point, "ci95": [lo, hi], "decisions": n}

    # ---- the rule
    valid = v1["A"] < 1e-9 and v1["N"] < 1e-9 and v2["A"] < 1e-5 and v2["N"] < 1e-5
    rule = {}
    for k in ("N", "M"):
        fewer = genuine["arms"][k]["perMin"] < genuine["arms"]["A"]["perMin"]
        within = all(I[v][k]["deltaPoints"] >= MARGIN for v in ("raw", "scaled"))
        rule[k] = {"fewerRequests": fewer, "captureWithin5Points": within, "acceptable": bool(valid and fewer and within)}
    ok = [k for k in ("N", "M") if rule[k]["acceptable"]]
    choice = min(ok, key=lambda k: genuine["arms"][k]["perMin"]) if ok else None

    code = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()
    res = {"code": code, "seconds": round(time.time() - t0, 1), "valid": valid, "V1": v1, "V2": v2, "ownerMedianStep": own_med,
           "genuine": genuine, "impostors": {"users": len(imp), "I": I}, "rule": rule, "choice": choice}
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "reenrol_result.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1)
    g = genuine
    lines = [f"Re-enrolment check, code {code[:12]}, valid {valid} (V1 A {v1['A']:.1e}, N {v1['N']:.1e}; V2 A {v2['A']:.1e}, N {v2['N']:.1e})",
             f"his checks of 22-24 Nov: {g['checks']} ({g['nonWarmupChecks']} non-warm-up, {g['minutes']:.1f} min of movement, {g['segments']} segments), "
             f"{g['liveRequestsUnderA']} live requests under A"]
    for k in ("A", "N", "M"):
        x = g["arms"][k]
        lines.append(f"  {k}: threshold {x['threshold']:.4f}, requests {x['requests']} ({x['perMin']:.2f}/min), checks at 33+ {x['checksAt33']}, "
                     f"mean low {x['meanLow']:.1f}; the 5 checks since N went live: {x['sinceNLive']}")
    for v in ("raw", "scaled"):
        for k in ("N", "M"):
            x = I[v][k]
            lines.append(f"impostors {v}: A {x['captureA']:.1f}%, {k} {x['capture']:.1f}% ({x['deltaPoints']:+.1f} points, 95% [{x['ci95'][0]:+.1f}, {x['ci95'][1]:+.1f}])")
    lines.append(f"rule: {json.dumps(rule)}; choice: {choice}")
    txt = "\n".join(lines)
    open(os.path.join(a.out, "reenrol_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
