"""Why does the owner's mouse channel ask for the passkey so often in real use? (owner, 22 Oct 2026: "I usually turn the
feature off because of false rejections; I don't know whether the cause is the approach or the weak enrolment interface,
dots that appear and the person clicks the circle").

Inputs are read-only exports of the owner's own rows from the live ca database (kept outside the repository):
  decisions.csv  mouse_decisions: checked_at, threshold, low_windows, suspicious, scores (the last 60 window scores)
  samples.csv    mouse_samples: id, created_at, windows (raw |dx|, |dy| windows of the enrolment page, 55 per sample)

Three comparisons:
  1. Live versus enrolment scores. The live windows of each check after the current profile was trained (the newest
     six scores of each check, about the windows added since the previous check), against the profile's
     leave-one-sample-out percentiles (its threshold is their 20th percentile).
  2. Enrolment movement versus SapiMouse movement. Step lengths of the owner's enrolment windows against the same
     windows built from SapiMouse's sessions (the 19 development users of protocol L, both sessions).
  3. The owner among SapiMouse users. The owner's leave-one-sample-out percentiles against the development users'
     (protocol L stage D, the F2 path; their `ref` streams are leave-one-sample-out scores).

    python services/model-api/analysis/phase7/owner_mouse_diagnosis.py --dir /app/owner --trained "2026-10-05 12:53:17" \
        --loso '{"10":0.170,"20":0.316,"50":0.687}'
"""
import argparse
import csv
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
import l_common as LC  # noqa: E402
import analyze_l as A  # noqa: E402

csv.field_size_limit(10 ** 9)


def step_stats(W):
    """W: windows (n, 50, 2) of |dx|, |dy| in pixels."""
    s = np.hypot(W[..., 0], W[..., 1]).ravel()
    path = np.hypot(W[..., 0], W[..., 1]).sum(axis=1)
    return {"windows": int(len(W)), "stepMedianPx": float(np.median(s)), "stepMeanPx": float(np.mean(s)),
            "stepP90Px": float(np.percentile(s, 90)), "shareStepsOver50Px": float((s > 50).mean()),
            "shareZeroSteps": float((s == 0).mean()), "windowPathMedianPx": float(np.median(path))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--trained", required=True, help="trained_at of the current profile")
    ap.add_argument("--loso", required=True, help="the profile's leave-one-sample-out percentiles (JSON)")
    a = ap.parse_args()
    loso = {int(k): float(v) for k, v in json.loads(a.loso).items()}

    # 1. live versus enrolment scores
    rows = list(csv.reader(open(os.path.join(a.dir, "decisions.csv"), encoding="utf-8")))
    cur = [r for r in rows if r[0] >= a.trained]
    thr = float(cur[0][1]) if cur else float("nan")
    new = np.concatenate([np.asarray(json.loads(r[4]), float)[-6:] for r in cur]) if cur else np.zeros(0)
    susp = sum(int(r[3]) for r in cur)
    minutes = len(cur) * 1.6 / 60.0
    live = {"checks": len(cur), "suspicious": susp, "requestsPerMinute": susp / minutes if minutes else None,
            "threshold": thr, "liveWindows": int(len(new)), "shareBelowThreshold": float((new < thr).mean()),
            "livePercentiles": {p: float(np.percentile(new, p)) for p in (10, 20, 50)}, "losoPercentiles": loso,
            "meanLowPerCheck": float(np.mean([int(r[2]) for r in cur]))}

    # 2. enrolment movement versus SapiMouse
    srows = list(csv.reader(open(os.path.join(a.dir, "samples.csv"), encoding="utf-8")))
    own = np.concatenate([np.asarray(json.loads(r[2]), float) for r in srows])
    own_last8 = np.concatenate([np.asarray(json.loads(r[2]), float) for r in srows[-8:]])
    j, _ = LC.splits()
    Wr = LC.Windows("owner diagnosis")
    dev = list(j["development"])
    sapi_long = np.concatenate([Wr.get(u, "long") for u in dev if len(Wr.get(u, "long"))])
    sapi_short = np.concatenate([Wr.get(u, "short") for u in dev if len(Wr.get(u, "short"))])
    movement = {"ownerEnrolmentAll": step_stats(own), "ownerEnrolmentLast8": step_stats(own_last8),
                "sapimouse3min": step_stats(sapi_long), "sapimouse1min": step_stats(sapi_short)}

    # 3. the owner among the development users (stage D F2 leave-one-sample-out scores)
    folder, path, d, hashes, V, code = A.load(False, None)
    U = next(iter(V["F2"].values()))
    dev_p = {u: {p: float(np.percentile(U[u]["ref"], p)) for p in (10, 20, 50)} for u in d["targets"]}
    med = sorted(v[50] for v in dev_p.values())
    p20 = sorted(v[20] for v in dev_p.values())
    rank = {"ownerLosoMedian": loso.get(50), "devMedians": med, "ownerBelowHowManyDevMedians": int(sum(m > loso.get(50, 0) for m in med)),
            "ownerLosoP20": loso.get(20), "devP20": p20, "ownerBelowHowManyDevP20": int(sum(x > loso.get(20, 0) for x in p20))}

    res = {"live": live, "movement": movement, "ownerAmongDevUsers": rank}
    json.dump(res, open(os.path.join(a.dir, "diagnosis.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
