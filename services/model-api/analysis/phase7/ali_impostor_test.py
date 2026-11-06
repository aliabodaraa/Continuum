"""Impostors on the owner's account "ali" (demo id 1 = internal user 739935229538144), mouse channel, read-only.

His LIVE head (f2_head.json fetched from the model store, 128 weights + bias, trained 2026-10-24 15:08:28Z on 440
windows) and his live threshold 0.26208394455013234 (ca.mouse_profiles) score the 20 SapiMouse people the deployed
network never saw (artifacts/mouse-fcn-a5/holdout_users.json, not in its cohort). Each recorded session (3-minute and
1-minute) is one impostor attempt, replayed through the live rule: a check every 6 windows (about 1.6 s of movement)
once the buffer holds 60 windows; the passkey is asked at the first check with 33 or more of the last 60 windows below
the threshold (MOUSE_STRIKES_TO_LOCK = 1). Two versions of every attempt: as recorded (other people's devices), and
every step rescaled to his median step (10.198 px, stored by experiment RU), a first-order model of the same device.

Validity: the disjoint 60-window decisions over each person's long+short windows must reproduce experiment RU's
77.1% (raw) and 57.0% (scaled) on 293 decisions for his profile A (artifacts/phase7/ru_test_a1_result.json).

Run: copy <model_path>/f2_head.json out of the model store (model_store.ensure_local inside the model-inference pod;
model_path from ca.mouse_profiles) into <dir>, then, with the repo mounted read-only and a 4 GB cap:
    docker run --rm --memory 4g -v "<repo>:/app:ro" -v "<dir>:/data" --entrypoint python continuum/model-api:local \
        /app/services/model-api/analysis/phase7/ali_impostor_test.py --head /data/f2_head.json --out /data/out
Result of 2026-11-06: artifacts/phase7/ali_impostor_result.json.
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, "/app/services/model-api")
sys.path.insert(0, "/app/services/model-api/analysis/phase2")
sys.path.insert(0, "/app/services/model-api/analysis/phase1")
import api  # noqa: E402
import l_common as LC  # noqa: E402

TAU = 0.26208394455013234
OWN_MED = 10.198039054870605
N, K, CADENCE = 60, 33, 6
SEC_PER_STEP = 0.0269            # p1lib.seconds_at: (50 + 10 * idx) * 0.0269 s of movement
HOLDOUT = "/app/artifacts/mouse-fcn-a5/holdout_users.json"
MARKS = (20, 30, 45, 60, 90, 120, 180)


def seconds_at(idx):
    return (50 + 10 * idx) * SEC_PER_STEP


def first_request(sc):
    """Index of the window at which the live loop first asks for the passkey, or None."""
    for i in range(len(sc)):
        if (i + 1) % CADENCE or i + 1 < N:
            continue
        if int((sc[i - N + 1:i + 1] < TAU).sum()) >= K:
            return i
    return None


def disjoint(sc):
    return [int((sc[i:i + N] < TAU).sum()) >= K for i in range(0, len(sc) - N + 1, N)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--head", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    t0 = time.time()

    h = json.load(open(a.head, encoding="utf-8"))
    st = api._f2_state()
    same = {k: (h[k] == st[k]) for k in ("cohortSha256", "baseModelSha256", "scalerSha256")}
    assert all(same.values()), f"the head was trained on another network/cohort/scaler: {same}"
    from sklearn.linear_model import LogisticRegression
    clf = LogisticRegression(C=1.0, solver="lbfgs", max_iter=5000)
    clf.classes_ = np.asarray(h["classes"], dtype=h["classesDtype"])
    clf.coef_ = np.asarray([h["coef"]], dtype=h["coefDtype"])
    clf.intercept_ = np.asarray(h["intercept"], dtype=h["interceptDtype"])
    clf.n_features_in_ = len(h["coef"])

    users = json.load(open(HOLDOUT))["holdout_users"]
    W = LC.Windows("impostors on ali")
    out = {"raw": [], "scaled": []}
    validity = {"raw": [], "scaled": []}
    for u in users:
        parts = {s: W.get(u, s) for s in ("long", "short")}
        allX = np.concatenate([x for x in parts.values() if len(x)])
        med = float(np.median(np.hypot(allX[..., 0], allX[..., 1])))
        k = OWN_MED / med if med > 0 else 1.0
        for mode in ("raw", "scaled"):
            conv = (lambda X: X) if mode == "raw" else (lambda X: np.round(X * k))
            sc_all = clf.predict_proba(api._f2_embed(conv(allX)))[:, 1]
            validity[mode].extend(disjoint(sc_all))
            for s, X in parts.items():
                if len(X) < N:
                    continue
                sc = clf.predict_proba(api._f2_embed(conv(X)))[:, 1]
                f = first_request(sc)
                out[mode].append({"user": u, "session": s, "windows": int(len(X)),
                                  "sessionSeconds": round(seconds_at(len(X) - 1), 1),
                                  "acceptedWindowShare": round(float((sc >= TAU).mean()), 3),
                                  "caughtAtSeconds": None if f is None else round(seconds_at(f), 1),
                                  "scale": round(k, 3)})

    summary = {}
    for mode, rows in out.items():
        t = [r["caughtAtSeconds"] for r in rows if r["caughtAtSeconds"] is not None]
        n = len(rows)
        per_user_first = {}
        for r in rows:
            per_user_first.setdefault(r["user"], []).append(r["caughtAtSeconds"])
        summary[mode] = {
            "attempts": n,
            "caught": len(t),
            "caughtShare": round(100 * len(t) / n, 1),
            "caughtBy": {f"{m}s": round(100 * sum(1 for x in t if x <= m) / n, 1) for m in MARKS},
            "meanSecondsToCatch": round(float(np.mean(t)), 1) if t else None,
            "medianSecondsToCatch": round(float(np.median(t)), 1) if t else None,
            "neverCaught": [f'{r["user"]}/{r["session"]} ({r["sessionSeconds"]} s, {100 * r["acceptedWindowShare"]:.0f}% windows accepted)'
                            for r in rows if r["caughtAtSeconds"] is None],
            "peopleCaughtInEverySession": sum(1 for u, v in per_user_first.items() if all(x is not None for x in v)),
            "disjointDecisionsAsk": round(100 * float(np.mean(validity[mode])), 2),
            "disjointDecisions": len(validity[mode]),
        }
    res = {"account": "ali (demo id 1) = 739935229538144", "headTrainedAtUtc": h["trainedAtUtc"], "threshold": TAU,
           "network": api.MOUSE_BASE_MODEL_PATH, "cohortSha256": st["cohortSha256"][:12],
           "rule": "check every 6 windows (~1.6 s), passkey at the first check with >= 33 of the last 60 below the threshold",
           "impostors": "20 SapiMouse people never seen by the network (holdout_users.json), each 3-min and 1-min session",
           "validityTarget": {"raw": 77.1, "scaled": 57.0, "decisions": 293},
           "summary": summary, "attempts": out, "seconds": round(time.time() - t0, 1)}
    os.makedirs(a.out, exist_ok=True)
    json.dump(res, open(os.path.join(a.out, "ali_impostor_result.json"), "w", encoding="utf-8"), indent=1)
    for mode in ("raw", "scaled"):
        s = summary[mode]
        print(f"{mode:6} validity {s['disjointDecisionsAsk']}% of {s['disjointDecisions']} decisions | "
              f"caught {s['caught']}/{s['attempts']} ({s['caughtShare']}%) | by {s['caughtBy']} | "
              f"mean {s['meanSecondsToCatch']} s, median {s['medianSecondsToCatch']} s | "
              f"people caught in every session {s['peopleCaughtInEverySession']}/20")
        for x in s["neverCaught"]:
            print("        never caught:", x)
    print("seconds", res["seconds"])


if __name__ == "__main__":
    main()
