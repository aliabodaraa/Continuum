"""Experiment RU: stage 2 of learning from real use (artifacts/phase7/PREREGISTRATION_RU.md).

The pre-registration was frozen on 25 Oct 2026 at 13:48 UTC, before this file was written. The script compares the
owner's live mouse profile (A, eight enrolment samples) with a mix (B, his newest four enrolment samples and his four
real-use samples). The genuine side replays his later live checks, and the impostor side scores the 20 held-out SapiMouse
users, raw and scaled to his step size. Both profiles are built as api.train_user_f2_payload builds them.

It reads an export of his data, made with his permission and kept outside the repository:
    samples.csv      mouse_samples: id, created_at, windows
    use_samples.csv  mouse_use_samples: id, anchor_id, anchor_at, received_at, threshold, windows, scores
    live.csv         mouse_decisions joined with mouse_live_windows: decision_id, checked_at, window_count, threshold,
                     low_windows, warmup, suspicious, scores, windows
    profile.csv      mouse_profiles: user_id, threshold, trained_at, model_path, decision_version
Only aggregates are written, to --out as ru_<mode>_result.json and .txt.

Run inside the model-api image (mounts as in TODO.md section 9):
    python /app/services/model-api/analysis/phase7/run_ru.py --data /data --out /out --mode smoke
    python ... --mode test --start "2026-10-25 21:00:00" --end "<cut-off>" [--exclude "<from>|<to>" ...]
"""
import argparse
import csv
import hashlib
import json
import os
import sys
import time
from datetime import datetime

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "..")))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase1")))
import api  # noqa: E402
import loso  # noqa: E402
import l_common as LC  # noqa: E402
import p1lib as P  # noqa: E402

PREREG = "/app/artifacts/phase7/PREREGISTRATION_RU.md"
PREREG_SHA = "72786bf8f69f12ab22f5013059c12c7a48ffa24eb3269db5820d6764d2080d1d"
# Amendment A1 (owner, 25 Oct 14:25 UTC): a same-day test from 14:35 UTC, at least 375 non-warm-up checks in any number
# of sittings; "keep A" is final for this mix, "the mix is better" needs the next-day test before stage 3.
A1 = "/app/artifacts/phase7/PREREGISTRATION_RU_A1.md"
A1_SHA = "b39a80a59c403080e4a78e59a58743c8924ac7a1174eb69f40f807950cf3b707"
A1_MIN_CHECKS = 375
HOLDOUT = "/app/artifacts/mouse-fcn-a5/holdout_users.json"
LIVE_THRESHOLD = 0.26208394455013234
LIVE_TRAINED = "2026-10-24 15:08:29"
A_IDS = [32, 33, 35, 37, 136, 205, 206, 239]
B_ENROL, B_USE = [136, 205, 206, 239], [1, 2, 3, 4]
N, K = 60, 33
SEC_PER_CHECK = 1.6
BLOCK = 75
BOOT, SEED = 10000, 17
MIN_CHECKS, SITTING_GAP_S = 1125, 3600
MARGIN_POINTS = -5.0
DIAGNOSTIC = {"raw": 77.1, "scaled": 57.0}
SMOKE_END = "2026-10-25 13:30:38"
INJECTED = ("2026-10-25 09:54:33", "2026-10-25 09:54:54")
OPEN_SEGMENTS = 8


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def ts(s):
    return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")


def read_csv(path):
    csv.field_size_limit(10 ** 9)
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


# ------------------------------------------------------------------ profiles --
def build(P_windows):
    """api.train_user_f2_payload without the file writes: the deployed embedder, cohort and negatives seed, the
    leave-one-sample-out scores with the purge, and the 20th percentile as the threshold."""
    X = api.to_window_array(P_windows.tolist())
    n = len(X)
    assert n % loso.SAMPLE == 0 and n // loso.SAMPLE >= 2, n
    E = api._f2_embed(X)
    C = api._f2_state()["C"]
    neg = C[np.random.default_rng(api.F2_NEG_SEED).choice(len(C), 2 * n, replace=False)]
    full = api._f2_fit(E, neg)
    oof = np.zeros(n)
    for s in range(n // loso.SAMPLE):
        lo, hi = s * loso.SAMPLE, (s + 1) * loso.SAMPLE
        keep = np.array([i for i in range(n) if i < lo - loso.PURGE or i >= hi + loso.PURGE])
        oof[lo:hi] = api._f2_fit(E[keep], neg).predict_proba(E[lo:hi])[:, 1]
    return {"head": full, "threshold": float(np.percentile(oof, 20)), "windows": n}


class Scorer:
    """Embeds each distinct window once; scores it with any head."""

    def __init__(self):
        self.index, self.rows = {}, []

    def add(self, windows):
        keys = []
        for w in windows:
            k = np.asarray(w, np.float32).tobytes()
            if k not in self.index:
                self.index[k] = len(self.rows)
                self.rows.append(np.asarray(w, np.float32))
            keys.append(self.index[k])
        return keys

    def embed(self):
        self.E = api._f2_embed(api.to_window_array(np.stack(self.rows).tolist())) if self.rows else None

    def scores(self, head):
        return head.predict_proba(self.E)[:, 1]


# ------------------------------------------------------------------ genuine ---
def select_checks(rows, mode, start, end, excludes):
    out = []
    for r in rows:
        t = r["checked_at"][:19]
        if mode == "smoke":
            if t >= SMOKE_END or INJECTED[0] <= t <= INJECTED[1]:
                continue
        else:
            if t < start or t > end:
                continue
        if any(a <= t <= b for a, b in excludes):
            continue
        out.append(r)
    return sorted(out, key=lambda r: int(r["decision_id"]))


def segments(checks, keys_of):
    """Joins consecutive checks into continuous window streams by exact overlap. A check extends the most recent open
    segment whose last windows equal its first windows (largest overlap first), or starts a new one."""
    segs, overlaps = [], []
    for ci, r in enumerate(checks):
        W = keys_of[ci]
        best = None
        for seg in reversed(segs[-OPEN_SEGMENTS:]):
            s = seg["w"]
            for o in range(min(len(s), len(W)), 0, -1):
                if s[-o:] == W[:o]:
                    if best is None or o > best[1]:
                        best = (seg, o)
                    break
        if best is None:
            seg = {"w": list(W), "checks": []}
            segs.append(seg)
            overlaps.append(0)
        else:
            seg, o = best
            seg["w"].extend(W[o:])
            overlaps.append(o)
        seg["checks"].append((len(seg["w"]) - 1, ci))
    return segs, overlaps


def replay(segs, win_scores, tau):
    """The live loop at the recorded check positions: 33 of the last 60 below tau asks for the passkey, and a check
    needs 60 windows since the segment start or since this arm's last request (the buffer empties)."""
    asked = set()
    for seg in segs:
        sc = win_scores[np.asarray(seg["w"])]
        start = 0
        for pos, ci in seg["checks"]:
            if pos - start + 1 < N:
                continue
            if int((sc[pos - N + 1:pos + 1] < tau).sum()) >= K:
                asked.add(ci)
                start = pos + 1
    return asked


def block_ci(a_counts, b_counts, minutes):
    nb = len(minutes)
    point = (b_counts.sum() - a_counts.sum()) / minutes.sum()
    rng = np.random.default_rng(SEED)
    d = np.empty(BOOT)
    for i in range(BOOT):
        idx = rng.integers(0, nb, nb)
        d[i] = (b_counts[idx].sum() - a_counts[idx].sum()) / minutes[idx].sum()
    lo, hi = np.percentile(d, [2.5, 97.5])
    return float(point), float(lo), float(hi)


# ------------------------------------------------------------------ impostors --
def impostor_data(own_med):
    W = LC.Windows("RU impostors")
    j, _ = LC.splits()
    users = list(j["development"])
    assert set(users) == set(json.load(open(HOLDOUT))["holdout_users"]), "the impostors must be the held-out users"
    data = {}
    for u in users:
        X = [W.get(u, w) for w in ("long", "short") if len(W.get(u, w))]
        if not X:
            continue
        X = np.concatenate(X)
        med = float(np.median(np.hypot(X[..., 0], X[..., 1])))
        k = own_med / med if med > 0 else 1.0
        data[u] = {"raw": X, "scaled": np.round(X * k), "median": med}
    return data


def disjoint_caught(sc, tau):
    return [int((sc[i:i + N] < tau).sum()) >= K for i in range(0, len(sc) - N + 1, N)]


def users_ci(per_user_a, per_user_b):
    users = sorted(per_user_a)
    ca = np.array([sum(per_user_a[u]) for u in users], float)
    cb = np.array([sum(per_user_b[u]) for u in users], float)
    n = np.array([len(per_user_a[u]) for u in users], float)
    point = 100 * (cb.sum() - ca.sum()) / n.sum()
    rng = np.random.default_rng(SEED)
    d = np.empty(BOOT)
    for i in range(BOOT):
        idx = rng.integers(0, len(users), len(users))
        d[i] = 100 * (cb[idx].sum() - ca[idx].sum()) / n[idx].sum()
    lo, hi = np.percentile(d, [2.5, 97.5])
    return float(point), float(lo), float(hi), 100 * ca.sum() / n.sum(), 100 * cb.sum() / n.sum(), int(n.sum())


# ------------------------------------------------------------------ main ------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=("smoke", "test"), required=True)
    ap.add_argument("--start", default="2026-10-25 21:00:00")
    ap.add_argument("--end", default=None)
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--amendment", choices=("A1",), default=None)
    a = ap.parse_args()
    if sha(PREREG) != PREREG_SHA:
        raise SystemExit("PREREGISTRATION_RU.md does not match its frozen hash; refusing to run")
    if a.amendment == "A1":
        if sha(A1) != A1_SHA:
            raise SystemExit("PREREGISTRATION_RU_A1.md does not match its frozen hash; refusing to run")
        if a.mode != "test" or a.start != "2026-10-25 14:35:00" or not a.end or a.end > "2026-10-25 20:59:59":
            raise SystemExit("amendment A1: test mode, --start '2026-10-25 14:35:00' and an --end no later than 20:59:59 UTC")
    if a.mode == "test" and not a.end:
        raise SystemExit("--end (the cut-off of the reading rule) is required in test mode")
    excludes = [tuple(x.split("|")) for x in a.exclude]
    t0 = time.time()
    res = {"experiment": "RU", "mode": a.mode, "preregSha256": PREREG_SHA, "codeSha256": sha(os.path.abspath(__file__)),
           "network": api.MOUSE_BASE_MODEL_PATH, "cohortSha256": api._f2_state()["cohortSha256"],
           "startedUtc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
           "period": {"start": a.start, "end": a.end} if a.mode == "test" else {"before": SMOKE_END, "without": INJECTED},
           "excluded": excludes}

    # --- the two profiles
    S = {int(r["id"]): np.asarray(json.loads(r["windows"]), np.float32) for r in read_csv(os.path.join(a.data, "samples.csv"))}
    U = {int(r["id"]): np.asarray(json.loads(r["windows"]), np.float32) for r in read_csv(os.path.join(a.data, "use_samples.csv"))}
    for i in A_IDS:
        assert S[i].shape == (55, 50, 2), (i, S[i].shape)
    for i in B_USE:
        assert U[i].shape == (55, 50, 2), (i, U[i].shape)
    PA = np.concatenate([S[i] for i in A_IDS])
    PB = np.concatenate([S[i] for i in B_ENROL] + [U[i] for i in B_USE])
    arms = {"A": build(PA), "B": build(PB)}
    res["thresholds"] = {k: v["threshold"] for k, v in arms.items()}
    prof = read_csv(os.path.join(a.data, "profile.csv"))[0]
    v1 = abs(arms["A"]["threshold"] - LIVE_THRESHOLD) < 1e-9 and abs(float(prof["threshold"]) - LIVE_THRESHOLD) < 1e-12
    res["V1"] = {"pass": bool(v1), "rebuilt": arms["A"]["threshold"], "live": float(prof["threshold"])}

    # --- genuine side
    rows = read_csv(os.path.join(a.data, "live.csv"))
    checks = select_checks(rows, a.mode, a.start, a.end or "", excludes)
    sc = Scorer()
    keys_of = [sc.add(json.loads(r["windows"])) for r in checks]
    sc.embed()
    win = {k: sc.scores(v["head"]) for k, v in arms.items()} if sc.rows else {"A": np.zeros(0), "B": np.zeros(0)}
    # V2: A's offline scores equal the live scores, with the same low count and verdict, on every check
    worst, mism = 0.0, []
    for ci, r in enumerate(checks):
        live = np.asarray(json.loads(r["scores"]), float)
        mine = win["A"][np.asarray(keys_of[ci])][-N:]
        if len(live) != len(mine):
            mism.append(int(r["decision_id"]))
            continue
        worst = max(worst, float(np.max(np.abs(live - mine))) if len(live) else 0.0)
        lows = int((mine < LIVE_THRESHOLD).sum())
        verdict = len(mine) >= N and lows >= K
        if lows != int(r["low_windows"]) or verdict != bool(int(r["suspicious"])):
            mism.append(int(r["decision_id"]))
    res["V2"] = {"pass": bool(worst <= 1e-5 and not mism), "maxAbsScoreDiff": worst, "mismatchedChecks": mism[:20],
                 "mismatches": len(mism), "checks": len(checks)}
    thr_seen = sorted({round(float(r["threshold"]), 15) for r in checks})
    res["V4"] = {"pass": bool(prof["trained_at"][:19] == LIVE_TRAINED and all(abs(t - LIVE_THRESHOLD) < 1e-12 for t in thr_seen)),
                 "profileTrainedAt": prof["trained_at"], "thresholdsOnChecks": thr_seen}

    segs, overlaps = segments(checks, keys_of)
    asked = {k: replay(segs, win[k], arms[k]["threshold"]) for k in arms}
    nonwarm = [ci for ci, r in enumerate(checks) if not int(r["warmup"])]
    times = [ts(r["checked_at"]) for r in checks]
    sittings = 1 + sum(1 for i in range(1, len(times)) if (times[i] - times[i - 1]).total_seconds() >= SITTING_GAP_S) if times else 0
    nb = (len(checks) + BLOCK - 1) // BLOCK
    cnt = {k: np.zeros(nb) for k in arms}
    for k in arms:
        for ci in asked[k]:
            cnt[k][ci // BLOCK] += 1
    minutes = np.array([min(BLOCK, len(checks) - b * BLOCK) * SEC_PER_CHECK / 60 for b in range(nb)])
    total_min = float(minutes.sum())
    G = None
    if nb:
        point, lo, hi = block_ci(cnt["A"], cnt["B"], minutes)
        G = {"deltaPerMin": point, "ci95": [lo, hi], "pass": bool(hi < 0)}
    enough = len(nonwarm) >= A1_MIN_CHECKS if a.amendment == "A1" else (len(nonwarm) >= MIN_CHECKS and sittings >= 2)
    # reported only
    live_asked = [ci for ci, r in enumerate(checks) if int(r["suspicious"])]
    b_at_live = []
    for ci in live_asked:
        ks = np.asarray(keys_of[ci])[-N:]
        b_at_live.append(int((win["B"][ks] < arms["B"]["threshold"]).sum()))
    per_check = {k: float(np.mean([int((win[k][np.asarray(keys_of[ci])[-N:]] < arms[k]["threshold"]).sum()) >= K for ci in nonwarm]))
                 if nonwarm else None for k in arms}
    stream_ids = sorted({i for s in segs for i in s["w"]})
    res["genuine"] = {
        "checks": len(checks), "nonWarmupChecks": len(nonwarm), "sittings": sittings, "minutes": total_min,
        "segments": len(segs), "streamWindows": int(sum(len(s["w"]) for s in segs)), "distinctWindows": len(sc.rows),
        "overlapHistogram": {str(o): overlaps.count(o) for o in sorted(set(overlaps))},
        "smallOverlapChecks": [int(checks[i]["decision_id"]) for i, o in enumerate(overlaps) if 0 < o < 5][:20],
        "requests": {k: len(asked[k]) for k in arms},
        "requestsPerMin": {k: (len(asked[k]) / total_min if total_min else None) for k in arms},
        "liveRequests": len(live_asked), "liveRequestsReplayedByA": len(set(live_asked) & asked["A"]),
        "bLowAtLiveRequests": b_at_live,
        "lowWindowShare": {k: (float((win[k][stream_ids] < arms[k]["threshold"]).mean()) if stream_ids else None) for k in arms},
        "perCheckVerdictShare": per_check,
        "G": G, "minimumMet": bool(enough),
    }

    # --- impostor side
    own_med = float(np.median(np.hypot(PA[..., 0], PA[..., 1])))
    imp = impostor_data(own_med)
    isc = Scorer()
    ikeys = {u: {v: isc.add(d[v]) for v in ("raw", "scaled")} for u, d in imp.items()}
    isc.embed()
    iwin = {k: isc.scores(v["head"]) for k, v in arms.items()}
    I, runs = {}, {}
    for v in ("raw", "scaled"):
        per = {k: {u: disjoint_caught(iwin[k][np.asarray(ikeys[u][v])], arms[k]["threshold"]) for u in imp} for k in arms}
        point, lo, hi, ca, cb, n = users_ci(per["A"], per["B"])
        I[v] = {"captureA": ca, "captureB": cb, "deltaPoints": point, "ci95": [lo, hi], "decisions": n, "pass": bool(lo >= MARGIN_POINTS)}
        runs[v] = {}
        for k in arms:
            caught = []
            for u in imp:
                s = iwin[k][np.asarray(ikeys[u][v])]
                for r0 in range(0, len(s) - P.IMP_RUN + 1, P.IMP_RUN):
                    c, _, _ = P.replay(s[r0:r0 + P.IMP_RUN], arms[k]["threshold"], "vote", N, K)
                    caught.append(c > 0)
            runs[v][k] = float(np.mean(caught)) if caught else None
    res["V3"] = {"pass": bool(abs(round(I["raw"]["captureA"], 1) - DIAGNOSTIC["raw"]) <= 0.1 and
                              abs(round(I["scaled"]["captureA"], 1) - DIAGNOSTIC["scaled"]) <= 0.1),
                 "raw": I["raw"]["captureA"], "scaled": I["scaled"]["captureA"], "diagnostic": DIAGNOSTIC}
    res["impostors"] = {"users": len(imp), "ownerMedianStep": own_med, "I": I, "runsCaught150": runs}

    # --- poisoning check (reported only)
    acc_b = {u: float((iwin["B"][np.asarray(ikeys[u]["raw"])] >= arms["B"]["threshold"]).mean()) for u in imp}
    top = max(acc_b, key=acc_b.get)
    Xt = imp[top]["raw"]
    PB_pois = np.concatenate([PB[:-loso.SAMPLE], Xt[:loso.SAMPLE]])
    pois = build(PB_pois)
    rest = Xt[N:]
    psc = Scorer()
    pk = psc.add(rest)
    psc.embed()
    cap = {}
    for name, arm in (("B", arms["B"]), ("Bpoisoned", pois)):
        cap[name] = float(np.mean(disjoint_caught(psc.scores(arm["head"])[np.asarray(pk)], arm["threshold"])) * 100) if len(rest) >= N else None
    res["poisoning"] = {"impostor": top, "rawAcceptanceUnderB": acc_b[top], "thresholdPoisoned": pois["threshold"], "capture": cap}

    # --- verdict
    valid = all(res[v]["pass"] for v in ("V1", "V2", "V3", "V4"))
    if not valid:
        verdict = "invalid: a validity check failed, nothing is read (pre-registration, validity checks)"
    elif a.mode == "smoke":
        verdict = "smoke run: a pipeline check, not evidence"
    elif not enough:
        verdict = "inconclusive: the minimum data were not met, A stays"
    elif G["pass"] and I["raw"]["pass"] and I["scaled"]["pass"]:
        verdict = ("the mix is better on the day of its samples: the next-day test must confirm it before stage 3"
                   if a.amendment == "A1" else "the mix is better: propose stage 3 to the owner")
    else:
        verdict = "keep A: final for this mix (a same-day test favours it)" if a.amendment == "A1" else "keep A"
    res["verdict"] = verdict
    res["amendment"] = {"name": a.amendment, "sha256": A1_SHA, "minChecks": A1_MIN_CHECKS} if a.amendment else None
    res["seconds"] = round(time.time() - t0, 1)
    os.makedirs(a.out, exist_ok=True)
    stem = os.path.join(a.out, f"ru_{a.mode}_result")
    with open(stem + ".json", "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1)
    g = res["genuine"]
    lines = [f"Experiment RU ({a.mode}{', amendment ' + a.amendment if a.amendment else ''}), prereg {PREREG_SHA[:12]}, code {res['codeSha256'][:12]}",
             f"V1 {res['V1']['pass']} (A threshold {arms['A']['threshold']:.6f}), V2 {res['V2']['pass']} "
             f"(max diff {res['V2']['maxAbsScoreDiff']:.2e}, {res['V2']['mismatches']} mismatches of {len(checks)}), "
             f"V3 {res['V3']['pass']} (raw {I['raw']['captureA']:.1f}, scaled {I['scaled']['captureA']:.1f}), V4 {res['V4']['pass']}",
             f"B threshold {arms['B']['threshold']:.6f}",
             f"genuine: {g['checks']} checks ({g['nonWarmupChecks']} non-warm-up, {g['sittings']} sittings, {g['minutes']:.1f} min), "
             f"{g['segments']} segments; requests A {g['requests']['A']}, B {g['requests']['B']} "
             f"(live {g['liveRequests']}, of which A's replay asked at {g['liveRequestsReplayedByA']})"]
    if G:
        lines.append(f"G: B - A = {G['deltaPerMin']:+.3f} requests/min, 95% [{G['ci95'][0]:+.3f}, {G['ci95'][1]:+.3f}], pass {G['pass']}")
    for v in ("raw", "scaled"):
        x = I[v]
        lines.append(f"I {v}: A {x['captureA']:.1f}%, B {x['captureB']:.1f}%, B - A {x['deltaPoints']:+.1f} points, "
                     f"95% [{x['ci95'][0]:+.1f}, {x['ci95'][1]:+.1f}], pass {x['pass']}")
    lines.append(f"poisoning ({top}): capture B {cap['B']}, poisoned {cap['Bpoisoned']}")
    lines.append(f"verdict: {verdict}")
    txt = "\n".join(lines)
    open(stem + ".txt", "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
