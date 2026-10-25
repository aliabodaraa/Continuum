"""Experiment PR: ask for the passkey only when the mouse suspicion persists (artifacts/phase7/PREREGISTRATION_PR.md).

Owner, 22-23 Oct 2026: "why would the passkey appear as long as he is the real user?", then "apply" to measuring a rule
that waits for the suspicion to persist. Paper Table 6's system (experiment FS: the base-80 network trained with
SapiMouse's settings, the F2 head, 440 enrolment windows, the 19 development users), scored with the same code as
score_fs.py, except that every impostor contributes its whole 1-minute session so that slower rules have room to fire.
  A_S: a request after S consecutive suspicious checks (the live streak; A_1 is the deployed rule).
  B_S: a request after S independent suspicious decisions in a row (the buffer is emptied after each one).
Checks run every 6 windows on the last 60, and a check is suspicious with 33 or more low windows. Validity: the genuine
and reference scores equal the stored FS units, the first 150 windows of every impostor session equal the stored runs,
and A_1 on runs cut at 150 windows reproduces Table 6's live loop.

    python services/model-api/analysis/phase7/run_pr.py --threads 6     # artifacts/phase7/pr_result.json / .txt
"""
import argparse
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase6")))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402
import mouse_live_decision_length as MLD  # noqa: E402
import train_fs as T  # noqa: E402

P = MLD.P
PREREG = "/app/artifacts/phase7/PREREGISTRATION_PR.md"
OUT = "/app/artifacts/phase7"
N, K, CADENCE = 60, 33, 6
RULES = [("A", s) for s in (1, 2, 3, 4, 6, 8, 11)] + [("B", s) for s in (2, 3)]
B, SEED, MARGIN = 10000, 17, -0.05


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def boot(d):
    d = np.asarray(d, float)
    m = d[np.random.default_rng(SEED).integers(0, len(d), (B, len(d)))].mean(1)
    return {"mean": float(d.mean()), "lo": float(np.percentile(m, 2.5)), "hi": float(np.percentile(m, 97.5)), "n": len(d)}


def replay(seq, tau, kind, s_needed):
    """Requests and the index of the first one, for rule A (consecutive checks) or B (independent decisions)."""
    s = np.asarray(seq, float)
    start, streak, prompts, first = 0, 0, 0, None
    for i in range(len(s)):
        if (i + 1) % CADENCE or i - start + 1 < N:
            continue                                   # no check here, or the buffer is not full: no verdict
        if int((s[i - N + 1:i + 1] < tau).sum()) >= K:
            streak += 1
            if streak >= s_needed:
                prompts += 1
                first = i if first is None else first
                start, streak = i + 1, 0               # request: the buffer is emptied
            elif kind == "B":
                start = i + 1                          # the next decision waits for 60 new windows
        else:
            streak = 0
    return prompts, first


def per_user(U, tau, kind, s_needed, cut=None):
    g = np.asarray(U["genuine"], float)
    cnt, _ = replay(g, tau, kind, s_needed)
    caught, times = [], []
    for r in U["runs"].values():
        c, f = replay(np.asarray(r, float)[:cut], tau, kind, s_needed)
        caught.append(c > 0)
        if c:
            times.append(P.seconds_at(f))
    return {"prompts": cnt / (len(g) * P.SEC_PER_WINDOW / 60.0), "never": cnt == 0,
            "caught": float(np.mean(caught)), "times": times}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=6)
    a = ap.parse_args()
    prereg = sha(PREREG)
    if prereg != open(PREREG.replace(".md", ".sha256")).read().split()[0]:
        raise SystemExit("PREREGISTRATION_PR.md changed after it was frozen")
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(a.threads)

    m = tf.keras.models.load_model(os.path.join(T.NET, "final_model"), compile=False)
    emb = LC.embedder_from(tf.keras.Model(m.input, m.get_layer("embedding").output), LC.load_scaler())
    j, _ = LC.splits()
    W = LC.Windows("PR")
    dev = list(j["development"])
    targets = sorted([u for u in dev if len(W.get(u, "long")) >= LC.BUDGET], key=lambda u: int(u[4:]))
    pool = [u for u in dev if len(W.get(u, "short"))]
    mu, C = LC.cohort(emb, W, LC.base80_users())
    Z = {u: LC.unit(emb(W.get(u, "short")) - mu) for u in sorted(set(targets) | set(pool))}
    units = {}
    for u in targets:
        E_enrol = LC.unit(emb(W.get(u, "long")[:LC.BUDGET]) - mu)
        tests = {"genuine": Z[u], **{o: Z[o] for o in pool if o != u and len(Z[o])}}   # whole impostor sessions
        s, ref = LC.head_scores(E_enrol, C, tests)
        units[u] = LC._unit_of(s, ref)
    LC.check_finite(units, "PR")

    # validity against the stored FS units (Table 6) and its live loop
    fs = LC.units_from_json(json.load(open(os.path.join(T.OUT, "scores_FS.json")))["units"])
    worst = 0.0
    for u in targets:
        for k in ("genuine", "ref"):
            worst = max(worst, float(np.max(np.abs(np.asarray(units[u][k], float) - np.asarray(fs[u][k], float)))))
        if sorted(units[u]["runs"]) != sorted(fs[u]["runs"]):
            raise SystemExit(f"{u}: impostor sessions differ from the stored runs")
        for o, r in fs[u]["runs"].items():
            worst = max(worst, float(np.max(np.abs(np.asarray(units[u]["runs"][o], float)[:len(r)] - np.asarray(r, float)))))
    if worst > 1e-6:
        raise SystemExit(f"scores do not reproduce the stored FS units (max difference {worst:.2e})")
    cut = [per_user(units[u], units[u]["tau"], "A", 1, cut=LC.IMP_RUN) for u in targets]
    check = {"promptsPerMin": float(np.mean([c["prompts"] for c in cut])), "runsCaught": float(np.mean([c["caught"] for c in cut]))}
    ref_live = next(r for r in json.load(open(os.path.join(OUT, "fs_paper_numbers.json")))["FS"]["rows"] if r["windows"] == N)["live"]
    if abs(check["promptsPerMin"] - ref_live["promptsPerMinMean"]) > 1e-9 or abs(check["runsCaught"] - ref_live["impostorRunsCaught"]) > 1e-9:
        raise SystemExit(f"A_1 on 150-window runs does not reproduce Table 6's live loop: {check} vs {ref_live}")

    per = {f"{kind}{s}": {u: per_user(units[u], units[u]["tau"], kind, s) for u in targets} for kind, s in RULES}
    rows = {}
    for name, pu in per.items():
        times = [t for v in pu.values() for t in v["times"]]
        rows[name] = {"promptsPerMin": float(np.mean([v["prompts"] for v in pu.values()])),
                      "usersNeverAsked": float(np.mean([v["never"] for v in pu.values()])),
                      "sessionsCaught": float(np.mean([v["caught"] for v in pu.values()])),
                      "timeToCatchMeanS": float(np.mean(times)) if times else None}
        if name != "A1":
            rows[name]["vsA1"] = {"prompts": boot([pu[u]["prompts"] - per["A1"][u]["prompts"] for u in targets]),
                                  "caught": boot([pu[u]["caught"] - per["A1"][u]["caught"] for u in targets])}
            rows[name]["acceptable"] = bool(rows[name]["vsA1"]["caught"]["lo"] >= MARGIN)
    rows["A1"]["acceptable"] = True
    ok = [n for n in rows if rows[n]["acceptable"]]
    best = min(ok, key=lambda n: (rows[n]["promptsPerMin"], rows[n]["timeToCatchMeanS"] or 1e9))
    res = {"what": "experiment PR, a request only when the mouse suspicion persists (Table 6's system)",
           "preregistrationPrSha256": prereg, "network": T.NET, "users": len(targets),
           "validity": {"maxScoreDifference": worst, "a1On150WindowRuns": check, "table6Live": ref_live},
           "impostorSessionWindowsMean": float(np.mean([len(r) for u in targets for r in units[u]["runs"].values()])),
           "rows": rows, "recommended": best}
    json.dump(res, open(os.path.join(OUT, "pr_result.json"), "w"), indent=1)

    L = [f"EXPERIMENT PR (prereg {prereg[:12]}): {len(targets)} development users, whole impostor sessions "
         f"(mean {res['impostorSessionWindowsMean']:.0f} windows); validity: scores equal FS (max diff {worst:.1e}), "
         f"A1 on 150-window runs = {check['promptsPerMin']:.2f}/min, {check['runsCaught'] * 100:.1f}% (Table 6)",
         f"{'rule':>4} {'requests/min':>12} {'never asked':>11} {'caught':>7} {'catch s':>7} | requests vs A1 [95%]   caught vs A1 [95%]   acceptable"]
    for name, r in rows.items():
        v = r.get("vsA1")
        cmp = "" if v is None else (f" | {v['prompts']['mean']:+.2f} [{v['prompts']['lo']:+.2f}, {v['prompts']['hi']:+.2f}]  "
                                    f"{v['caught']['mean'] * 100:+.1f} [{v['caught']['lo'] * 100:+.1f}, {v['caught']['hi'] * 100:+.1f}]  "
                                    f"{'yes' if r['acceptable'] else 'no'}")
        t = f"{r['timeToCatchMeanS']:7.1f}" if r["timeToCatchMeanS"] is not None else "      -"
        L.append(f"{name:>4} {r['promptsPerMin']:12.2f} {r['usersNeverAsked'] * 100:10.0f}% {r['sessionsCaught'] * 100:6.1f}% {t}{cmp}")
    L.append(f"RECOMMENDED (fewest requests among rules within 5 points of A1's capture): {best}")
    txt = "\n".join(L)
    open(os.path.join(OUT, "pr_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
