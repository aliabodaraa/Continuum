"""
Mechanical application of artifacts/repr_arch_study/PREREGISTRATION_C.md.

Reuses the audited functions of repr_arch_analyze.py (calibration/test halves, operating-point
selection, decision rates, paired bootstrap). Refuses results produced under another hash or
with a seed missing.

    python repr_enrol_analyze.py --arch B8
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
PREREG_C = os.path.join(ROOT, "PREREGISTRATION_C.md")
DELTA = 0.02                     # non-inferiority margin, AUC
SEC_PER_STEP = 0.0269


def lower95(a, b, seed=17):
    """Paired bootstrap of mean(b - a): (mean, 95% CI) over users."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    d = b[ok] - a[ok]
    st = d[np.random.default_rng(seed).integers(0, len(d), (RA.N_BOOT, len(d)))].mean(1)
    return float(d.mean()), float(np.percentile(st, 2.5)), float(np.percentile(st, 97.5))


def condition(docs, mode, b):
    """Per-user test metrics for one (mode, budget), averaged over seeds; each seed picks its
    own operating point on calibration, exactly as in Experiments A/B."""
    per = {}
    for d in docs:
        units = {r["participant"]: r[mode][str(b)] for r in d["perUser"]}
        split = {u: RA.halves(x) for u, x in units.items()}
        enrol = {u: np.asarray(x["_enrolScores"], float) for u, x in units.items()}
        op = RA.choose_op({u: s[0] for u, s in split.items()}, enrol)
        for u, (cal, test) in split.items():
            e = per.setdefault(u, {"auc": [], "eer": [], "tar01": [], "cap": [], "fl": [],
                                   "interrupted": [], "latency": []})
            wm = RA.window_metrics(test)
            e["auc"].append(wm["auc"]); e["eer"].append(wm["eer"]); e["tar01"].append(wm["tar01"])
            if op:
                r = RA.rates(test, float(np.percentile(enrol[u], op["q"])), op["rule"], op["n"], op["k"])
                if r:
                    e["cap"].append(r["cap"]); e["fl"].append(r["fl"])
                    e["interrupted"].append(float(r["interrupted"]))
                    if r["latencyWindows"] is not None:
                        e["latency"].append(r["latencyWindows"])
    return {u: {k: (float(np.mean(v)) if v else np.nan) for k, v in m.items()} for u, m in per.items()}


def pooled_op(docs, mode, b, budget):
    """C-3: one operating point chosen on the calibration halves of all (target, seed) pairs."""
    units, enrol = {}, {}
    for d in docs:
        for r in d["perUser"]:
            key = f"{r['participant']}|{d['seedIndex']}"
            units[key] = RA.halves(r[mode][str(b)])
            enrol[key] = np.asarray(r[mode][str(b)]["_enrolScores"], float)
    old = RA.FL_BUDGET
    RA.FL_BUDGET = budget
    try:
        op = RA.choose_op({k: v[0] for k, v in units.items()}, enrol)
    finally:
        RA.FL_BUDGET = old
    if not op:
        return None
    res = [RA.rates(v[1], float(np.percentile(enrol[k], op["q"])), op["rule"], op["n"], op["k"])
           for k, v in units.items()]
    res = [r for r in res if r]
    lat = [r["latencyWindows"] for r in res if r["latencyWindows"] is not None]
    lat_w = float(np.median(lat)) if lat else None
    return {**op, "flBudget": budget,
            "testFLmedian": float(np.median([r["fl"] for r in res])),
            "testFLmean": float(np.mean([r["fl"] for r in res])),
            "testCaptureMedian": float(np.median([r["cap"] for r in res])),
            "testCaptureMean": float(np.mean([r["cap"] for r in res])),
            "interruptedShare": float(np.mean([r["interrupted"] for r in res])),
            "neverDetectedShare": float(1 - np.mean([r["detected"] for r in res])),
            "latencyWindowsMedian": lat_w,
            "latencySecondsMedian": (50 + 10 * (lat_w - 1)) * SEC_PER_STEP if lat_w else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", required=True)
    ap.add_argument("--root", default=ROOT)
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    prereg = os.path.join(args.root, "PREREGISTRATION_C.md")
    sha = hashlib.sha256(open(prereg, "rb").read()).hexdigest()
    docs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(args.root, "parts", f"C_{args.arch}_s*.json")))]
    if len(docs) != 3:
        sys.exit(f"REFUSING: need 3 seeds, found {len(docs)}")
    if any(d["preregistrationCSha256"] != sha for d in docs):
        sys.exit("REFUSING: results produced under a different Experiment C pre-registration")
    budgets = docs[0]["budgets"]
    bmax = max(budgets)

    C = {m: {b: condition(docs, m, b) for b in budgets} for m in ("M1", "M2")}
    users = sorted(set.intersection(*[set(C[m][b]) for m in C for b in budgets]))
    v = lambda m, b, k: [C[m][b][u][k] for u in users]
    print(f"pre-registration C {sha[:12]} verified | arch {args.arch} | {len(users)} targets | budgets {budgets}")
    print(f"\n{'mode':<5}{'budget':>7}{'~sec':>6}{'AUC':>7}{'medAUC':>8}{'EER%':>7}{'T@F1%':>7}"
          f"{'CAP%':>7}{'FL%':>6}{'intr%':>7}")
    for m in ("M1", "M2"):
        for b in budgets:
            f = lambda k: np.nanmean(v(m, b, k))
            print(f"{m:<5}{b:>7}{(50 + 10*(b-1))*SEC_PER_STEP:>6.0f}{f('auc'):>7.3f}"
                  f"{np.nanmedian(v(m, b, 'auc')):>8.3f}{f('eer')*100:>7.1f}{f('tar01')*100:>7.1f}"
                  f"{f('cap')*100:>7.1f}{f('fl')*100:>6.1f}{f('interrupted')*100:>7.0f}")

    # C-1
    print(f"\nC-1 (server M1): AUC(b) - AUC({bmax}), 95% CI; non-inferior if lower bound >= -{DELTA}")
    c1 = {}
    for b in budgets:
        mean, lo, hi = lower95(v("M1", bmax, "auc"), v("M1", b, "auc"))
        c1[b] = {"meanDiff": mean, "ci95": [lo, hi], "nonInferior": lo >= -DELTA}
        print(f"   b={b:>3}: {mean:+.4f}  [{lo:+.4f}, {hi:+.4f}]  {'non-inferior' if lo >= -DELTA else 'NOT non-inferior'}")
    bmin = min(b for b in budgets if c1[b]["nonInferior"])
    print(f"   -> b_min = {bmin} windows (~{(50 + 10*(bmin-1))*SEC_PER_STEP:.0f} s of session)")

    # C-2
    mean, lo, hi = lower95(v("M1", bmin, "auc"), v("M2", bmin, "auc"))
    cap = RA.boot(v("M1", bmin, "cap"), v("M2", bmin, "cap"))
    # Fail safe: if capture cannot be compared (no operating point met the budget), the
    # non-inferiority of M2 on capture is not established, so the server mode is kept.
    cap_ok = np.isfinite(cap["meanDiff"]) and not (cap["meanDiff"] < 0 and cap["p"] < 0.05)
    m2_ok = lo >= -DELTA and cap_ok
    mode = "M2" if m2_ok else "M1"
    print(f"\nC-2 at b_min: M2 - M1 AUC {mean:+.4f} [{lo:+.4f}, {hi:+.4f}]; capture "
          f"{cap['meanDiff']*100:+.1f} pp p {cap['p']:.4f} -> recommend "
          f"{'ON-DEVICE (M2)' if m2_ok else 'SERVER (M1)'}")

    # C-3
    ops = {bud: pooled_op(docs, mode, bmin, bud) for bud in (0.01, 0.02, 0.05)}
    print(f"\nC-3 operating points for {mode} at b_min={bmin} (chosen on calibration, reported on test):")
    for bud, op in ops.items():
        if not op:
            print(f"   FL budget {bud:.0%}: no operating point meets it on calibration"); continue
        print(f"   FL budget {bud:.0%}: q={op['q']:>2} {op['rule']} n={op['n']} k={op['k']} | test FL median "
              f"{op['testFLmedian']*100:.1f}% mean {op['testFLmean']*100:.1f}% | capture median "
              f"{op['testCaptureMedian']*100:.1f}% | interrupted {op['interruptedShare']*100:.0f}% | "
              f"never detected {op['neverDetectedShare']*100:.1f}% | latency {op['latencySecondsMedian'] or float('nan'):.1f} s")

    out = {"preregistrationCSha256": sha, "arch": args.arch, "targets": users,
           "table": {m: {str(b): {k: float(np.nanmean(v(m, b, k))) for k in
                                  ("auc", "eer", "tar01", "cap", "fl", "interrupted")}
                         for b in budgets} for m in C},
           "C1": {str(b): x for b, x in c1.items()}, "bmin": bmin,
           "C2": {"M2minusM1AUC": [mean, lo, hi], "capture": cap, "recommend": mode},
           "C3": {str(k): x for k, x in ops.items()}}
    path = os.path.join(args.root, f"analysis_C_{args.arch}.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1, default=lambda o: None if isinstance(o, float) and np.isnan(o) else o)
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
