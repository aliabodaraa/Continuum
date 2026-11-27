"""One-sitting enrolment check (27 Nov 2026): the comparison fixed in COORDINATION.md (commit 7fab52f) before this file
was written.

On 27 Nov the owner reset his mouse profile and enrolled again in one sitting on the task pad (samples 302-309), and the
new profile T rejected every window of his use. The question is the product's, not his account's: a new user enrols
once, in one session. Arms, each built as api.train_user_f2_payload builds it (run_ru.build):
    A, M   the references of 25 Nov (run_reenrol.py)
    N, T   one sitting on the pad: 290-297 (25 Nov) and 302-309 (27 Nov)
    U_d    one sitting of real use: the first 440 distinct windows of his checks of day d, in time order, cut into
           8 samples of 55 (a day with fewer than 440 is left out)
    PU_d   the last four samples of T, then the first four samples of U_d
Genuine side: his 558 checks of 22-24 Nov replayed as in RU; for U_d and PU_d only the checks of the other days, with M
on the same checks. Impostor side: the 20 held-out SapiMouse users, disjoint 60-window decisions, raw and scaled to A's
median step. Valid only if A, N and M give the 25 Nov numbers again (artifacts/phase7/reenrol_result.json).
Question 1: for N and T, the highest threshold whose requests are not above M's, and the capture there (within 5 points
of M's, raw and scaled = a threshold rule could be enough; descriptive only).
Question 2: U_d and PU_d with the deployed threshold rule are acceptable when, on the other days' checks, requests per
minute are not above M's and capture is within 5 points of M's, raw and scaled, for every d.

Reads three private exports (kept outside the repository) and writes only aggregates:
    docker run --rm -m 6g -v <repo>:/repo -v <private dir>:/data:ro -w /repo continuum/model-api:local \
        python /repo/services/model-api/analysis/phase7/run_onesit.py --old /data/owner_mouse_2026-11-24.json \
        --new /data/owner_mouse_2026-11-25.json --today /data/owner_mouse_2026-11-27.json --out /repo/artifacts/phase7
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
M_IDS = [294, 295, 296, 297, 136, 205, 206, 239]
N_IDS = [290, 291, 292, 293, 294, 295, 296, 297]
T_IDS = [302, 303, 304, 305, 306, 307, 308, 309]
T_LIVE_TH = 0.7934675971572327
ENROL_WINDOWS, SAMPLE = 440, 55
MARGIN = -5.0
REF_25 = "artifacts/phase7/reenrol_result.json"


def auc(pos, neg):
    """P(a genuine window scores above an impostor window), ties counted half."""
    neg = np.sort(np.asarray(neg))
    lo = np.searchsorted(neg, pos, side="left")
    hi = np.searchsorted(neg, pos, side="right")
    return float((lo + 0.5 * (hi - lo)).sum() / (len(pos) * len(neg)))


def first_distinct(checks, limit):
    """The first `limit` distinct windows of these checks in time order, and how many checks it took."""
    seen, out = set(), []
    for n, c in enumerate(checks, 1):
        for w in c["windows"]:
            k = np.asarray(w, np.float32).tobytes()
            if k in seen:
                continue
            seen.add(k)
            out.append(np.asarray(w, np.float32))
            if len(out) == limit:
                return np.stack(out), n
    return None, len(checks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--today", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    t0 = time.time()
    old, new, today = (json.load(open(p, encoding="utf-8")) for p in (a.old, a.new, a.today))
    samples = {}
    for ex in (old, new, today):
        samples.update({s["id"]: s["windows"] for s in ex["samples"]})
    cat = lambda ids: np.concatenate([np.asarray(samples[i], np.float32) for i in ids])  # noqa: E731

    olds = sorted(old["checks"], key=lambda c: int(c["decision_id"]))
    todays = sorted(today["checks"], key=lambda c: int(c["decision_id"]))
    days = sorted({c["checked_at"][:10] for c in olds})

    # ---- arms
    arms = {k: RU.build(cat(ids)) for k, ids in (("A", A_IDS), ("M", M_IDS), ("N", N_IDS), ("T", T_IDS))}
    use = {}
    for d in days:
        X, took = first_distinct([c for c in olds if c["checked_at"][:10] == d], ENROL_WINDOWS)
        if X is None:
            use[d] = {"left_out": f"fewer than {ENROL_WINDOWS} distinct windows"}
            continue
        use[d] = {"checksToEnrol": took, "minutesToEnrol": took * RU.SEC_PER_CHECK / 60}
        arms["U_" + d] = RU.build(X)
        arms["PU_" + d] = RU.build(np.concatenate([cat(T_IDS[4:]), X[:4 * SAMPLE]]))

    # ---- validity against the 25 Nov run
    ref = json.load(open(REF_25, encoding="utf-8"))
    rg = ref["genuine"]["arms"]
    v_th = {k: abs(arms[k]["threshold"] - rg[k]["threshold"]) for k in ("A", "N", "M")}
    v_th["T"] = abs(arms["T"]["threshold"] - T_LIVE_TH)

    # ---- genuine windows, scored once per arm
    sc = RU.Scorer()
    k_old = [sc.add(c["windows"]) for c in olds]
    k_today = [sc.add(c["windows"]) for c in todays]
    n_old_windows = len({x for k in k_old for x in k})
    sc.embed()
    win = {k: sc.scores(arm["head"]) for k, arm in arms.items()}

    def genuine_on(idx, arm_keys):
        cs = [olds[i] for i in idx]
        ks = [k_old[i] for i in idx]
        segs, _ = RU.segments(cs, ks)
        minutes = sum(1 for c in cs if not c["warmup"]) * RU.SEC_PER_CHECK / 60
        out = {"checks": len(cs), "minutes": minutes}
        for k in arm_keys:
            asked = RU.replay(segs, win[k], arms[k]["threshold"])
            out[k] = {"requests": len(asked), "perMin": len(asked) / minutes if minutes else None}
        return out, segs

    all_idx = list(range(len(olds)))
    G, segs_all = genuine_on(all_idx, list(arms))
    v_req = {k: G[k]["requests"] - rg[k]["requests"] for k in ("A", "N", "M")}

    # ---- impostors
    own_med = float(np.median(np.hypot(cat(A_IDS)[..., 0], cat(A_IDS)[..., 1])))
    imp = RU.impostor_data(own_med)
    isc = RU.Scorer()
    ikeys = {u: {v: isc.add(dd[v]) for v in ("raw", "scaled")} for u, dd in imp.items()}
    isc.embed()
    iwin = {k: isc.scores(arm["head"]) for k, arm in arms.items()}

    def capture(k, tau):
        return {v: {u: RU.disjoint_caught(iwin[k][np.asarray(ikeys[u][v])], tau) for u in imp} for v in ("raw", "scaled")}

    per = {k: capture(k, arms[k]["threshold"]) for k in arms}
    cap = {k: {v: 100 * sum(sum(x) for x in per[k][v].values()) / sum(len(x) for x in per[k][v].values()) for v in ("raw", "scaled")} for k in arms}
    rc = ref["impostors"]["I"]
    v_cap = {"A_raw": cap["A"]["raw"] - rc["raw"]["N"]["captureA"], "A_scaled": cap["A"]["scaled"] - rc["scaled"]["N"]["captureA"],
             "N_raw": cap["N"]["raw"] - rc["raw"]["N"]["capture"], "N_scaled": cap["N"]["scaled"] - rc["scaled"]["N"]["capture"],
             "M_raw": cap["M"]["raw"] - rc["raw"]["M"]["capture"], "M_scaled": cap["M"]["scaled"] - rc["scaled"]["M"]["capture"]}
    valid = all(x < 1e-9 for x in v_th.values()) and all(x == 0 for x in v_req.values()) and all(abs(x) < 0.05 for x in v_cap.values())

    # separation of his real use from the impostors, threshold-free (descriptive)
    gidx = np.unique(np.concatenate([np.asarray(k) for k in k_old]))
    sep = {k: {"aucRaw": auc(win[k][gidx], np.concatenate([iwin[k][np.asarray(ikeys[u]["raw"])] for u in imp])),
               "aucScaled": auc(win[k][gidx], np.concatenate([iwin[k][np.asarray(ikeys[u]["scaled"])] for u in imp])),
               "realUseMedian": float(np.median(win[k][gidx]))} for k in arms}

    # ---- Question 1: the highest threshold with no more requests than M, for N and T
    grid = np.unique(np.concatenate([np.geomspace(1e-4, 0.999, 1500), np.linspace(0.001, 0.999, 999)]))
    Q1 = {}
    for k in ("N", "T"):
        ok = [t for t in grid if len(RU.replay(segs_all, win[k], t)) <= G["M"]["requests"]]
        if not ok:
            Q1[k] = {"threshold": None, "enough": False}
            continue
        tau = float(max(ok))
        p = capture(k, tau)
        c = {v: 100 * sum(sum(x) for x in p[v].values()) / sum(len(x) for x in p[v].values()) for v in ("raw", "scaled")}
        d = {v: RU.users_ci(per["M"][v], p[v]) for v in ("raw", "scaled")}
        Q1[k] = {"threshold": tau, "requests": len(RU.replay(segs_all, win[k], tau)), "capture": c,
                 "deltaPoints": {v: d[v][0] for v in d}, "ci95": {v: [d[v][1], d[v][2]] for v in d},
                 "enough": all(d[v][0] >= MARGIN for v in d)}

    # ---- Question 2: one sitting of real use, tested on the other days
    Q2 = {}
    for dday in days:
        if "U_" + dday not in arms:
            continue
        idx = [i for i, c in enumerate(olds) if c["checked_at"][:10] != dday]
        g, _ = genuine_on(idx, ["M", "U_" + dday, "PU_" + dday])
        for k in ("U_" + dday, "PU_" + dday):
            d = {v: RU.users_ci(per["M"][v], per[k][v]) for v in ("raw", "scaled")}
            fewer = g[k]["perMin"] <= g["M"]["perMin"]
            within = all(d[v][0] >= MARGIN for v in d)
            Q2[k] = {"testChecks": g["checks"], "testMinutes": g["minutes"], "threshold": arms[k]["threshold"],
                     "requests": g[k]["requests"], "perMin": g[k]["perMin"], "M_requests": g["M"]["requests"], "M_perMin": g["M"]["perMin"],
                     "capture": cap[k], "deltaPoints": {v: d[v][0] for v in d}, "ci95": {v: [d[v][1], d[v][2]] for v in d},
                     "notMoreRequests": bool(fewer), "captureWithin5Points": bool(within), "acceptable": bool(valid and fewer and within)}
    u_keys = [k for k in Q2 if k.startswith("U_")]
    pu_keys = [k for k in Q2 if k.startswith("PU_")]
    verdict = {"useEnrolmentAcceptable": bool(u_keys) and all(Q2[k]["acceptable"] for k in u_keys),
               "padPlusUseAcceptable": bool(pu_keys) and all(Q2[k]["acceptable"] for k in pu_keys),
               "thresholdCouldBeEnough": {k: Q1[k]["enough"] for k in Q1}}

    today_low = {k: [int((win[k][np.asarray(kk)] < arms[k]["threshold"]).sum()) for kk in k_today] for k in arms}
    code = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()
    res = {"code": code, "seconds": round(time.time() - t0, 1), "valid": valid,
           "validity": {"thresholds": v_th, "requestsVs25Nov": v_req, "captureVs25Nov": v_cap},
           "ownerMedianStepA": own_med, "days": days, "useEnrolment": use, "distinctRealUseWindows": n_old_windows,
           "thresholds": {k: arm["threshold"] for k, arm in arms.items()}, "genuineAll": G, "capture": cap,
           "separation": sep, "Q1": Q1, "Q2": Q2, "verdict": verdict, "todayChecksLow": today_low}
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "onesit_result.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1)
    L = [f"One-sitting enrolment check, code {code[:12]}, valid {valid}; {res['seconds']} s",
         f"validity: thresholds {json.dumps({k: f'{x:.1e}' for k, x in v_th.items()})}, requests vs 25 Nov {v_req}, "
         f"capture vs 25 Nov max {max(abs(x) for x in v_cap.values()):.3f} points",
         f"his checks of 22-24 Nov: {G['checks']} ({G['minutes']:.1f} min of movement); days {days}; enrolment from use: {json.dumps(use)}"]
    for k in arms:
        g = G[k]
        L.append(f"  {k:<14} threshold {arms[k]['threshold']:.4f}  all 558 checks: {g['requests']:>3} requests ({g['perMin']:.2f}/min)  "
                 f"capture raw {cap[k]['raw']:.1f}% scaled {cap[k]['scaled']:.1f}%  AUC raw {sep[k]['aucRaw']:.3f} scaled {sep[k]['aucScaled']:.3f}  "
                 f"real-use median {sep[k]['realUseMedian']:.3f}  today's 3 checks low {today_low[k]}")
    for k, x in Q1.items():
        if x["threshold"] is None:
            L.append(f"Q1 {k}: no threshold keeps requests at M's")
            continue
        L.append(f"Q1 {k}: threshold {x['threshold']:.4f} ({x['requests']} requests, M {G['M']['requests']}): capture raw {x['capture']['raw']:.1f}% "
                 f"({x['deltaPoints']['raw']:+.1f} vs M), scaled {x['capture']['scaled']:.1f}% ({x['deltaPoints']['scaled']:+.1f}); enough {x['enough']}")
    for k, x in Q2.items():
        L.append(f"Q2 {k}: on {x['testChecks']} checks of the other days ({x['testMinutes']:.1f} min): {x['requests']} requests ({x['perMin']:.2f}/min) "
                 f"vs M {x['M_requests']} ({x['M_perMin']:.2f}/min); capture raw {x['capture']['raw']:.1f}% ({x['deltaPoints']['raw']:+.1f} vs M, "
                 f"95% [{x['ci95']['raw'][0]:+.1f}, {x['ci95']['raw'][1]:+.1f}]), scaled {x['capture']['scaled']:.1f}% ({x['deltaPoints']['scaled']:+.1f}, "
                 f"95% [{x['ci95']['scaled'][0]:+.1f}, {x['ci95']['scaled'][1]:+.1f}]); acceptable {x['acceptable']}")
    L.append(f"verdict: {json.dumps(verdict)}")
    txt = "\n".join(L)
    open(os.path.join(a.out, "onesit_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
