"""Impostors on the owner's account "ali" (internal user 739935229538144), typing channel, read-only.

His LIVE typing model (copied from the model store: final_model-20261024T234408Z-63b414, fine-tuned from ws50-gru-v2
on 777 of his windows against Aalto A200 negatives) scores the windows of all 99 KeyRecs participants
(data/keyrecs_impostors.h5, the windows of the thesis's typing experiments; KeyRecs people never trained his model or
its base). The scoring path is the deployed one: api.get_user_model + api.scale_windows(to_window_array(W), None)
(the base scaler) + predict, genuine probability = column 1.

Attempts: each participant's window stream is cut into disjoint segments of SEG windows (each = a fresh page, the SDK
buffer empty), replayed through the live typing rule at the organisation's packet P:
  - a check at every new window once the typed text reaches minTextChars(P) = min(80, 50 + 10 P) characters,
    taken here as keystrokes = 51 + 10 (n - 1) after n windows;
  - while n <= P the check is warm-up, except the fast path: n >= 8 scored windows (the last min(n, P)) with at least
    ceil(0.75 k) below 0.50 asks for the passkey;
  - after warm-up a check asks for the passkey when at least half of the last P windows are below 0.50.
Validity V1: a few windows scored here equal the live model service's own /api/user/predict output (checked
separately with kubectl exec; pass --live-scores to compare).

Run (model folder copied from the model store with kubectl cp, mounted at its live path; 4 GB cap):
    docker run --rm --memory 4g -v "<work>:/work" -v "<model dir>:/app/artifacts/users/user-<id>/<model>:ro" \
        -v "<repo>/data/keyrecs_impostors.h5:/data/keyrecs_impostors.h5:ro" --entrypoint python continuum/model-api:local \
        /work/ali_ks_impostor_test.py --model /app/artifacts/users/user-<id>/<model> --h5 /data/keyrecs_impostors.h5 --out /work/out
Results of 2026-11-07: artifacts/phase7/ali_ks_impostor_result.json; the same test on windows built by the running
ca-service code (ks_rebuild.js + ali_ks_impostor_live.py): artifacts/phase7/ali_ks_impostor_live_result.json.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, "/app/services/model-api")
import api  # noqa: E402

SEG = 60
PACKETS = (2, 4, 6, 10, 20)
KEYS_PER_SECOND = 251 / 42.0     # the thesis's pace (251 keystrokes ~ 42 s)
MARKS = (100, 150, 250, 400, 600)


def min_text(p):
    return min(80, 50 + 10 * p)


def first_request(sc, p):
    """Window count n (1-based) at which the live rule first asks for the passkey in this segment, or None."""
    for n in range(1, len(sc) + 1):
        keys = 51 + 10 * (n - 1)
        if keys < min_text(p):
            continue
        if n <= p:
            k = min(n, p)
            last = sc[n - k:n]
            if k >= 8 and int((last < 0.5).sum()) >= math.ceil(0.75 * k):
                return n
            continue
        if int((sc[n - p:n] < 0.5).sum()) / p >= 0.5:
            return n
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--h5", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--probe", default=None, help="write the first 5 windows of participant 0 as JSON here")
    a = ap.parse_args()
    t0 = time.time()
    import h5py
    with h5py.File(a.h5, "r") as f:
        W = np.asarray(f["windows"], np.float32)
        pid = np.asarray(f["participant"]).astype(np.int64)
    model = api.get_user_model(a.model)
    X = api.scale_windows(api.to_window_array(W), None)
    scores = model.predict(X, batch_size=2048, verbose=0)[:, 1]
    ids = np.unique(pid)
    if a.probe:
        sel = np.where(pid == ids[0])[0][:5]
        json.dump({"windows": W[sel].tolist(), "offlineScores": scores[sel].tolist()}, open(a.probe, "w"))

    per_window_accept = float((scores >= 0.5).mean())
    res = {"account": "ali = 739935229538144", "model": os.path.basename(os.path.normpath(a.model)),
           "participants": int(len(ids)), "windows": int(len(W)), "segmentWindows": SEG,
           "impostorWindowsAccepted": round(100 * per_window_accept, 1), "packets": {}}
    for p in PACKETS:
        rows = []
        for u in ids:
            s = scores[pid == u]
            for start in range(0, len(s) - SEG + 1, SEG):
                n = first_request(s[start:start + SEG], p)
                rows.append({"user": int(u), "start": start, "caughtAtKeys": None if n is None else 51 + 10 * (n - 1)})
        caught = [r["caughtAtKeys"] for r in rows if r["caughtAtKeys"] is not None]
        per_user = {}
        for r in rows:
            per_user.setdefault(r["user"], []).append(r["caughtAtKeys"] is not None)
        res["packets"][str(p)] = {
            "attempts": len(rows), "caught": len(caught), "caughtShare": round(100 * len(caught) / len(rows), 1),
            "caughtByKeys": {str(m): round(100 * sum(1 for c in caught if c <= m) / len(rows), 1) for m in MARKS},
            "meanKeysToCatch": round(float(np.mean(caught)), 0) if caught else None,
            "medianKeysToCatch": round(float(np.median(caught)), 0) if caught else None,
            "medianSecondsToCatch": round(float(np.median(caught)) / KEYS_PER_SECOND, 1) if caught else None,
            "peopleCaughtInEverySegment": sum(1 for v in per_user.values() if all(v)),
            "peopleNeverCaught": sum(1 for v in per_user.values() if not any(v)),
            "people": len(per_user)}
    res["seconds"] = round(time.time() - t0, 1)
    os.makedirs(a.out, exist_ok=True)
    json.dump(res, open(os.path.join(a.out, "ali_ks_impostor_result.json"), "w"), indent=1)
    print(f"participants {res['participants']}, windows {res['windows']}, impostor windows accepted {res['impostorWindowsAccepted']}%")
    for p, s in res["packets"].items():
        print(f"packet {p:>2}: caught {s['caught']}/{s['attempts']} ({s['caughtShare']}%) | by keys {s['caughtByKeys']} | "
              f"median {s['medianKeysToCatch']} keys (~{s['medianSecondsToCatch']} s) | people always caught "
              f"{s['peopleCaughtInEverySegment']}/{s['people']}, never {s['peopleNeverCaught']}")
    print("seconds", res["seconds"])


if __name__ == "__main__":
    main()
