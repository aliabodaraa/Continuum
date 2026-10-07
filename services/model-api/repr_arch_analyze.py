"""
Mechanical application of artifacts/repr_arch_study/PREREGISTRATION.md.

Refuses to run if any result part was produced under a different pre-registration
(hash mismatch). Every selection uses the CALIBRATION half only; every reported
comparison uses the TEST half:
    genuine stream  -> first half calibration, second half test (temporal)
    impostor runs   -> identities sorted; even index calibration, odd index test

    python repr_arch_analyze.py --exp A
    python repr_arch_analyze.py --exp B --rep A3
"""
import argparse
import glob
import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keystroke_user_sweep import auc_of, eer_of, tar_at_far   # noqa: E402

ROOT = "/app/artifacts/repr_arch_study"
PREREG = os.path.join(ROOT, "PREREGISTRATION.md")
Q_GRID = [1, 2, 5, 10, 15, 20, 30, 40, 50]
RULES = ([("vote", n, k) for n in (6, 10, 20) for k in range(max(2, n // 2), n + 1)]
         + [("mean", n, None) for n in (6, 10, 20)] + [("median", n, None) for n in (6, 10, 20)])
FL_BUDGET = 0.05
N_BOOT = 10000
SEC_PER_STEP = 0.0269          # block_vs_window_native.json timeBasis (session time)
PUBLISHED_A = ["A2", "A3", "A4", "A5", "A7", "A8"]
MOUSE_PUBLISHED_B = {"B4", "B5", "B6", "B7", "B8", "B9"}
AMENDMENT_1 = os.path.join(ROOT, "AMENDMENT_1.md")        # Experiment B arm specifications


# ------------------------------------------------------------ splitting ----
def halves(u):
    g = np.asarray(u["_genuineScores"], float)
    cut = len(g) // 2
    ids = sorted(u["_impostorRuns"])
    runs = {k: np.asarray(u["_impostorRuns"][k], float) for k in ids}
    return ({"g": g[:cut], "runs": {k: runs[k] for k in ids[0::2]}},
            {"g": g[cut:], "runs": {k: runs[k] for k in ids[1::2]}})


def window_metrics(h):
    i = np.concatenate(list(h["runs"].values()))
    g = h["g"]
    return {"auc": float(auc_of(g, i)), "eer": float(eer_of(g, i)[0]),
            "tar01": float(tar_at_far(g, i, 0.01)[0])}


# ------------------------------------------------------------- decisions ----
def fires(seq, tau, rule, n, k):
    s = np.asarray(seq, float)
    if len(s) < n:
        return np.zeros(0, bool)
    if rule == "vote":
        low = (s < tau).astype(int)
        c = np.concatenate([[0], np.cumsum(low)])
        return (c[n:] - c[:-n]) >= k
    win = np.lib.stride_tricks.sliding_window_view(s, n)
    stat = win.mean(1) if rule == "mean" else np.median(win, 1)
    return stat < tau


def rates(h, tau, rule, n, k):
    fg = fires(h["g"], tau, rule, n, k)
    if not len(fg):
        return None
    caps, lat, det = [], [], []
    for r in h["runs"].values():
        f = fires(r, tau, rule, n, k)
        if not len(f):
            continue
        caps.append(float(f.mean()))
        hit = np.flatnonzero(f)
        det.append(bool(len(hit)))
        if len(hit):
            lat.append(int(hit[0]) + n)          # windows observed until the first lock
    if not caps:
        return None
    return {"fl": float(fg.mean()), "cap": float(np.mean(caps)),
            "interrupted": bool(fg.any()), "detected": float(np.mean(det)),
            "latencyWindows": float(np.median(lat)) if lat else None}


def choose_op(users_cal, enrol):
    """Highest median capture with median false-lock <= budget, on CALIBRATION."""
    best = None
    for q in Q_GRID:
        taus = {u: float(np.percentile(enrol[u], q)) for u in users_cal}
        for rule, n, k in RULES:
            fl, cap = [], []
            for u, h in users_cal.items():
                r = rates(h, taus[u], rule, n, k)
                if r:
                    fl.append(r["fl"]); cap.append(r["cap"])
            if len(fl) < 3:
                continue
            mfl, mcap = float(np.median(fl)), float(np.median(cap))
            if mfl <= FL_BUDGET and (best is None or mcap > best["calCap"]):
                best = {"q": q, "rule": rule, "n": n, "k": k, "calFL": mfl, "calCap": mcap}
    return best


# ------------------------------------------------------------ statistics ----
def boot(a, b, seed=17):
    """Paired mean difference b - a over users; two-sided bootstrap p."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    d = b[ok] - a[ok]
    rng = np.random.default_rng(seed)
    st = d[rng.integers(0, len(d), (N_BOOT, len(d)))].mean(1)
    p = 2 * min((st <= 0).mean(), (st >= 0).mean())
    return {"meanDiff": float(d.mean()), "ci95": [float(np.percentile(st, 2.5)),
                                                  float(np.percentile(st, 97.5))],
            "p": float(min(1.0, p)), "n": int(len(d)), "bBetter": int((d > 0).sum())}


def holm(ps):
    idx = np.argsort(ps); adj = np.empty(len(ps)); run = 0.0
    for r, i in enumerate(idx):
        run = max(run, (len(ps) - r) * ps[i]); adj[i] = min(1.0, run)
    return adj.tolist()


def sig_lower(res, p_key="pHolm"):
    """b significantly lower than a (res is b - a)."""
    return res["meanDiff"] < 0 and res[p_key] < 0.05


# ------------------------------------------------------------ per arm ----
def summarise_arm(docs):
    """Per-user values averaged over seeds, plus per-seed operating points."""
    per_user = {}
    ops = []
    for d in docs:
        rows = {r["participant"]: r for r in d["perUser"]}
        split = {u: halves(r) for u, r in rows.items()}
        enrol = {u: np.asarray(r["_enrolScores"], float) for u, r in rows.items()}
        op = choose_op({u: s[0] for u, s in split.items()}, enrol)
        ops.append(op)
        for u, (cal, test) in split.items():
            e = per_user.setdefault(u, {"calAUC": [], "auc": [], "eer": [], "tar01": [],
                                        "cap": [], "fl": [], "interrupted": [], "detected": [],
                                        "latency": []})
            e["calAUC"].append(window_metrics(cal)["auc"])
            wm = window_metrics(test)
            e["auc"].append(wm["auc"]); e["eer"].append(wm["eer"]); e["tar01"].append(wm["tar01"])
            if op:
                r = rates(test, float(np.percentile(enrol[u], op["q"])), op["rule"], op["n"], op["k"])
                if r:
                    e["cap"].append(r["cap"]); e["fl"].append(r["fl"])
                    e["interrupted"].append(float(r["interrupted"])); e["detected"].append(r["detected"])
                    if r["latencyWindows"] is not None:
                        e["latency"].append(r["latencyWindows"])
    users = sorted(per_user)
    mean = lambda k: {u: (float(np.mean(per_user[u][k])) if per_user[u][k] else np.nan) for u in users}
    return {"users": users, "calAUC": mean("calAUC"), "auc": mean("auc"), "eer": mean("eer"),
            "tar01": mean("tar01"), "cap": mean("cap"), "fl": mean("fl"),
            "interrupted": mean("interrupted"), "detected": mean("detected"),
            "latency": mean("latency"), "ops": ops,
            "baseTop1": float(np.mean([d["baseTop1"] for d in docs])),
            "params": docs[0]["perUserModelParams"], "nFeatures": docs[0]["nFeatures"],
            "desc": docs[0]["representationDesc"] if docs[0]["exp"] == "A" else docs[0]["architectureDesc"],
            "source": docs[0]["representationSource"] if docs[0]["exp"] == "A" else docs[0]["architectureSource"],
            "seeds": len(docs)}


def vec(S, arm, key, users):
    return [S[arm][key].get(u, np.nan) for u in users]


def table(S, order):
    print(f"\n{'arm':<5}{'input / architecture':<46}{'calAUC':>8}{'AUC':>7}{'medAUC':>8}{'EER%':>7}"
          f"{'T@F1%':>7}{'CAP%':>7}{'FL%':>6}{'intr%':>7}{'lat(s)':>8}{'top1':>6}{'params':>8}")
    for a in order:
        s = S[a]
        f = lambda k: np.nanmean(list(s[k].values()))
        lat = np.nanmedian(list(s["latency"].values()))
        lat_s = (50 + 10 * (lat - 1)) * SEC_PER_STEP if np.isfinite(lat) else np.nan
        print(f"{a:<5}{s['desc'][:45]:<46}{f('calAUC'):>8.3f}{f('auc'):>7.3f}"
              f"{np.nanmedian(list(s['auc'].values())):>8.3f}{f('eer')*100:>7.1f}{f('tar01')*100:>7.1f}"
              f"{f('cap')*100:>7.1f}{f('fl')*100:>6.1f}{f('interrupted')*100:>7.0f}{lat_s:>8.1f}"
              f"{s['baseTop1']:>6.3f}{s['params']:>8}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", choices=["A", "B"], required=True)
    ap.add_argument("--rep", default=None)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    sha = hashlib.sha256(open(PREREG, "rb").read()).hexdigest()
    pat = f"{args.exp}_*_s*.json" if args.exp == "A" else f"B_*_s*_{args.rep}.json"
    docs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(ROOT, "parts", pat)))]
    bad = [d["arm"] for d in docs if d["preregistrationSha256"] != sha]
    if bad:
        sys.exit(f"REFUSING: parts produced under a different pre-registration: {bad}")
    if args.exp == "B":
        amend = hashlib.sha256(open(AMENDMENT_1, "rb").read()).hexdigest()
        bad = [d["arm"] for d in docs if d.get("amendment1Sha256") != amend]
        if bad:
            sys.exit(f"REFUSING: Experiment B parts not produced under Amendment 1: {bad}")
    by_arm = {}
    for d in docs:
        by_arm.setdefault(d["arm"], []).append(d)
    incomplete = {a: len(v) for a, v in by_arm.items() if len(v) != 3}
    if incomplete:
        sys.exit(f"REFUSING: incomplete arms (need 3 seeds): {incomplete}")
    S = {a: summarise_arm(v) for a, v in sorted(by_arm.items())}
    users = sorted(set.intersection(*[set(s["users"]) for s in S.values()]))
    print(f"pre-registration {sha[:12]} verified on {len(docs)} parts | {len(users)} targets | "
          f"arms {sorted(S)}")
    order = sorted(S)
    table(S, order)

    out = {"preregistrationSha256": sha, "exp": args.exp, "targets": users,
           "arms": {a: {k: (v if not isinstance(v, dict) else {u: v.get(u) for u in users})
                        for k, v in S[a].items() if k != "users"} for a in order}}

    if args.exp == "A":
        elig = [a for a in PUBLISHED_A if a in S]
        cal = {a: float(np.nanmean(vec(S, a, "calAUC", users))) for a in elig}
        pstar = max(elig, key=lambda a: cal[a])
        print(f"\nstep 1 (calibration): best eligible published arm P* = {pstar} "
              f"(cal AUC {cal[pstar]:.3f}); A6 ineligible by pre-registration")
        fam = {p: boot(vec(S, p, "auc", users), vec(S, "A1", "auc", users)) for p in elig}
        for p, adj in zip(elig, holm([fam[p]["p"] for p in elig])):
            fam[p]["pHolm"] = adj
        print("step 2 (test, family A1 vs each eligible published arm, Holm):")
        for p in elig:
            r = fam[p]
            print(f"   A1 - {p}: {r['meanDiff']:+.4f} AUC  CI[{r['ci95'][0]:+.4f},{r['ci95'][1]:+.4f}]  "
                  f"p_holm {r['pHolm']:.4f}  A1 better for {r['bBetter']}/{r['n']}")
        capcmp = boot(vec(S, pstar, "cap", users), vec(S, "A1", "cap", users))
        a1_wins = fam[pstar]["meanDiff"] > 0 and fam[pstar]["pHolm"] < 0.05
        a1_cap_ok = not (capcmp["meanDiff"] < 0 and capcmp["p"] < 0.05)
        print(f"   capture@FL<=5%: A1 - {pstar} = {capcmp['meanDiff']*100:+.1f} pp  p {capcmp['p']:.4f}")
        if a1_wins and a1_cap_ok:
            adopted, why = "A1", f"A1 significantly better than P*={pstar} and not worse on capture"
            Sset = None
        else:
            others = [a for a in elig if a != pstar]
            cmp = {a: boot(vec(S, pstar, "auc", users), vec(S, a, "auc", users)) for a in others}
            for a, adj in zip(others, holm([cmp[a]["p"] for a in others]) if others else []):
                cmp[a]["pHolm"] = adj
            Sset = [pstar] + [a for a in others if not sig_lower(cmp[a])]
            adopted = min(Sset, key=lambda a: (S[a]["nFeatures"], -cal[a]))
            why = (f"A1 not significantly better than P*={pstar}; S = {Sset} (not significantly "
                   f"below P*); fewest input features -> {adopted}")
            print("step 3 (test, each eligible published arm vs P*, Holm):")
            for a in others:
                r = cmp[a]
                print(f"   {a} - {pstar}: {r['meanDiff']:+.4f}  p_holm {r['pHolm']:.4f}  "
                      f"{'SIGNIFICANTLY LOWER' if sig_lower(r) else 'not significantly lower'}")
        print(f"\nDECISION (pre-registered rule): adopt {adopted} -- {why}")
        out.update({"Pstar": pstar, "calAUC": cal, "familyA1vsPublished": fam,
                    "captureA1vsPstar": capcmp, "S": Sset, "adopted": adopted, "reason": why})
        # reported, not used for the decision
        out["A6_absolutePosition_vs_A1"] = boot(vec(S, "A1", "auc", users), vec(S, "A6", "auc", users)) if "A6" in S else None
    else:
        archs = order
        cal = {a: float(np.nanmean(vec(S, a, "calAUC", users))) for a in archs}
        astar = max(archs, key=lambda a: cal[a])
        others = [a for a in archs if a != astar]
        auc_c = {a: boot(vec(S, astar, "auc", users), vec(S, a, "auc", users)) for a in others}
        cap_c = {a: boot(vec(S, astar, "cap", users), vec(S, a, "cap", users)) for a in others}
        for fam in (auc_c, cap_c):
            for a, adj in zip(others, holm([fam[a]["p"] for a in others])):
                fam[a]["pHolm"] = adj
        Sset = [astar] + [a for a in others if not sig_lower(auc_c[a]) and not sig_lower(cap_c[a])]
        print(f"\nstep 1 (calibration): A* = {astar} (cal AUC {cal[astar]:.3f})")
        print("step 2 (test, each architecture vs A*, Holm within each endpoint):")
        for a in others:
            print(f"   {a} - {astar}: AUC {auc_c[a]['meanDiff']:+.4f} p_holm {auc_c[a]['pHolm']:.4f} | "
                  f"capture {cap_c[a]['meanDiff']*100:+.1f} pp p_holm {cap_c[a]['pHolm']:.4f} | "
                  f"{'in S' if a in Sset else 'excluded'}")
        # Pre-registration step 3, literally: the fewest-parameter member of S wins, unless the
        # RUNNER-UP has at most 10% more parameters; then prefer whichever of the two has
        # published mouse-dynamics support; if both or neither do, prefer the deployed B1 if it
        # is one of the two, else the fewer parameters.
        ranked = sorted(Sset, key=lambda a: S[a]["params"])
        adopted = ranked[0]
        if len(ranked) > 1 and S[ranked[1]]["params"] <= 1.10 * S[ranked[0]]["params"]:
            r0, r1 = ranked[0], ranked[1]
            m0, m1 = r0 in MOUSE_PUBLISHED_B, r1 in MOUSE_PUBLISHED_B
            if m0 != m1:
                adopted = r0 if m0 else r1
            elif "B1" in (r0, r1):
                adopted = "B1"
        why = (f"S = {Sset}; fewest per-user parameters; runner-up within 10% -> mouse-published, "
               f"then deployed B1")
        print(f"\nDECISION (pre-registered rule): adopt {adopted} -- {why}")
        out.update({"Astar": astar, "calAUC": cal, "aucVsAstar": auc_c, "captureVsAstar": cap_c,
                    "S": Sset, "adopted": adopted, "reason": why})

    name = f"analysis_{args.exp}" + (f"_{args.rep}" if args.exp == "B" else "") + ".json"
    with open(os.path.join(ROOT, name), "w") as f:
        json.dump(out, f, indent=1, default=lambda o: None if isinstance(o, float) and np.isnan(o) else o)
    print(f"wrote {os.path.join(ROOT, name)}")


if __name__ == "__main__":
    main()
