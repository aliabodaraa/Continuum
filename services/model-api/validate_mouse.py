"""Validation gate for the MOUSE channel — the counterpart to validate_pipeline.js
and validate_endtoend.py.

Run inside the model-api container:
    docker exec -w /app/services/model-api continuum-model-api-1 python validate_mouse.py

Exits non-zero if any check fails, so it can gate a deploy.

Replicates the EXACT payload services/ca-service/lib/mouse.js sends: no
baseModelPath, no scalerPath, no negativeWindows. The API must derive all three
from the modality, which is precisely what the repoint changed.
"""
import glob
import json
import os
import sys
import urllib.request

import numpy as np

sys.path.insert(0, "/app/services/model-api")
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402
from keystroke_user_sweep import auc_of, eer_of  # noqa: E402

API = "http://localhost:5000"
DATA = "/app/data/sapimouse"
WS, STRIDE = 50, 10
MIN_ENROLL = 150          # MIN_ENROLL_WINDOWS in mouse.js
OVERLAP_GAP = 5           # ceil(WS/STRIDE), what mouse.js sends
FAILS = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def post(path, body, timeout=1800):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def sessions(uid):
    cs = sorted(glob.glob(os.path.join(DATA, uid, "*.csv")))
    lo = [c for c in cs if "3min" in os.path.basename(c)]
    sh = [c for c in cs if "1min" in os.path.basename(c)]
    return (lo[0] if lo else None), (sh[0] if sh else None)


def wins(c):
    return np.asarray(steps_to_windows(events_to_steps(_read_events(c)), WS, STRIDE), np.float32)


print("=" * 72)
print("MOUSE CHANNEL — END-TO-END VERIFICATION")
print("=" * 72)

# ---------------------------------------------------------------- 1. artifacts
print("\n1. Base artifact the service will resolve")
ART = "/app/artifacts"
gru = os.path.join(ART, "mouse-ws50-gru")
check("clean base final_model exists", os.path.isdir(os.path.join(gru, "final_model")))
check("clean base scaler exists", os.path.isfile(os.path.join(gru, "scaler.json")))
res = json.load(open(os.path.join(gru, "results.json")))
check("base is the session-disjoint one", "session" in res.get("split", "").lower(),
      res.get("split", "")[:60])
check("base holds out 20 users",
      len(json.load(open(os.path.join(gru, "holdout_users.json")))["holdout_users"]) == 20)
sc = json.load(open(os.path.join(gru, "scaler.json")))
check("scaler is 7-dimensional", len(sc["mean"]) == 7, f"dims={len(sc['mean'])}")

# ---------------------------------------------------------------- 2. train
uid = "user111"                                    # a held-out subject
long_s, short_s = sessions(uid)
enroll = wins(long_s)[:250]
gen_test = wins(short_s)
print(f"\n2. Production training call  (target {uid}, {len(enroll)} enrol windows)")
print("   payload mirrors mouse.js: modality only, no paths, no negatives")
model_path_hint = None
tr = post("/api/user/train", {
    "userId": f"verify-{uid}",
    "positiveWindows": enroll.tolist(),
    "positiveGroups": [0] * len(enroll),
    "overlapGap": OVERLAP_GAP,
    "minPositiveWindows": MIN_ENROLL,
    "modality": "mouse",
    "epochs": 25, "batchSize": 32,
})
if "error" in tr:
    check("training succeeded", False, tr["error"])
    sys.exit(1)
model_path_hint = tr["modelPath"]
print(json.dumps({k: v for k, v in tr.items()
                  if k not in ("previousModelPath",)}, indent=2)[:900])

check("training returned ok", tr.get("ok") is True)
check("transferred from the base, not scratch",
      tr.get("trainedFrom") in ("base-model-fine-tune", "base-feature-extractor"),
      tr.get("trainedFrom"))
check("model path is under the service's own storage",
      "/artifacts/users/" in tr["modelPath"], tr["modelPath"])
check("input shape is (50, 7)", tr.get("inputShape") == [50, 7], str(tr.get("inputShape")))
check("negatives came from the dataset pool",
      tr.get("negativeSource") is not None and "dataset" in tr["negativeSource"],
      str(tr.get("negativeSource")))
check("no dataset-negative error", not tr.get("datasetNegativeError"),
      str(tr.get("datasetNegativeError")))
strategy = str(tr.get("splitStrategy", ""))
check("validation split is leak-aware (grouped or contiguous+gap, never shuffled)",
      ("contiguous" in strategy or "group" in strategy)
      and "shuffle" not in strategy and "random" not in strategy,
      strategy)
check("validation set is non-empty", (tr.get("validationWindowCount") or 0) > 0,
      str(tr.get("validationWindowCount")))
check("threshold within (0,1)", 0.0 < float(tr.get("threshold", -1)) < 1.0,
      str(tr.get("threshold")))

# ---------------------------------------------------------------- 3. predict
print("\n3. Scoring — genuine (1-min session) vs impostors (other held-out users)")
holdout = json.load(open(os.path.join(gru, "holdout_users.json")))["holdout_users"]
imp_users = [u for u in holdout if u != uid][:6]
imp = np.concatenate([wins(sessions(u)[1])[:60] for u in imp_users
                      if sessions(u)[1] is not None], axis=0)


def score(w):
    r = post("/api/user/predict", {"userId": f"verify-{uid}", "windows": np.asarray(w).tolist(),
                                   "modality": "mouse", "threshold": 0.5})
    return np.array([float(p[1]) for p in r.get("prediction", [])]), r


g, rg = score(gen_test)
i, _ = score(imp)
check("predict returned a score per genuine window", len(g) == len(gen_test),
      f"{len(g)}/{len(gen_test)}")
check("predict returned a score per impostor window", len(i) == len(imp),
      f"{len(i)}/{len(imp)}")
check("scores are probabilities", bool(g.min() >= 0 and g.max() <= 1))

eer, _ = eer_of(g, i)
auc = auc_of(g, i)
print(f"\n   genuine mean {g.mean():.3f} (n={len(g)})   impostor mean {i.mean():.3f} (n={len(i)})")
print(f"   AUC {auc:.3f}   EER {eer:.2%}   FAR@0.5 {(i>=0.5).mean():.2%}   TAR@0.5 {(g>=0.5).mean():.2%}")
check("model discriminates better than chance", auc > 0.6, f"AUC={auc:.3f}")
check("genuine scores above impostor scores", g.mean() > i.mean())

# ---------------------------------------------------------------- 4. decision
print("\n4. Deployed decision rule — sustained 15 of 20")
MOUSE_SUSTAIN_WINDOW, MOUSE_SUSTAIN_LOW = 20, 15


def sustained_fires(scores):
    """Fraction of 20-window positions where >=15 windows are below 0.5."""
    if len(scores) < MOUSE_SUSTAIN_WINDOW:
        return None
    fires = [(scores[k:k + MOUSE_SUSTAIN_WINDOW] < 0.5).sum() >= MOUSE_SUSTAIN_LOW
             for k in range(len(scores) - MOUSE_SUSTAIN_WINDOW + 1)]
    return float(np.mean(fires))


gf = sustained_fires(g)
imp_fire = [sustained_fires(i[k:k + 60]) for k in range(0, len(i) - 60 + 1, 60)]
imp_fire = [x for x in imp_fire if x is not None]
print(f"   genuine  false-lock rate : {gf:.2%}")
print(f"   impostor fire rate       : {np.mean(imp_fire):.2%} (per 60-window run)")
check("genuine false-lock stays low under the deployed rule", gf is not None and gf < 0.25,
      f"{gf:.2%}")
check("rule fires more on impostors than on the genuine user",
      np.mean(imp_fire) > gf, f"{np.mean(imp_fire):.2%} vs {gf:.2%}")

# ---------------------------------------------------------------- 5. contract
print("\n5. Multi-session enrolment — the group-split path")
print("   mouse.js tags each stored recording with its session index; with more")
print("   than one session the API must split by GROUP, not by position.")
enroll2 = wins(long_s)[:300]
half = len(enroll2) // 2
tr2 = post("/api/user/train", {
    "userId": f"verify2-{uid}",
    "positiveWindows": enroll2.tolist(),
    "positiveGroups": [0] * half + [1] * (len(enroll2) - half),   # two sessions
    "overlapGap": OVERLAP_GAP,
    "minPositiveWindows": MIN_ENROLL,
    "modality": "mouse",
    "epochs": 5, "batchSize": 32,
})
s2 = str(tr2.get("splitStrategy", ""))
print(f"   splitStrategy: {s2}")
check("two sessions select the group-aware split", "group" in s2, s2)
check("multi-session training succeeds", tr2.get("ok") is True)

print("\n6. Client/server feature contract")
js = open("/app/sdk/js/mouse-features.js").read()
check("SDK window size is 50", "WINDOW_SIZE = 50" in js)
check("SDK stride is 10", "WINDOW_STRIDE = 10" in js)
check("SDK emits 7 features", js.count("steps.push([") == 1 and "isClick," in js)

# ------------------------------------------------- 7. action-based path
print("\n7. Action-based path (Antal & Egyed-Zsigmond, IET Biometrics 2019)")
import h5py  # noqa: E402
ACT = "/app/data/mouse_only/Mouse_Actions.h5"
check("action dataset built", os.path.isfile(ACT))
if os.path.isfile(ACT):
    with h5py.File(ACT, "r") as fh:
        AX = np.array(fh["X"]); asubj = np.array(fh["subject"]); asess = np.array(fh["session"])
        atype = np.array(fh["action_type"])
        gap = float(fh.attrs.get("gap_seconds", -1)); mev = int(fh.attrs.get("min_events", -1))
    check("39 features per action", AX.shape[1] == 39, str(AX.shape[1]))
    check("published 10-second segmentation gap", gap == 10.0, str(gap))
    check("published 4-event minimum", mev == 4, str(mev))
    check("all 120 subjects present", len(np.unique(asubj)) == 120, str(len(np.unique(asubj))))
    check("point-and-click actions exist", int((atype == 3).sum()) > 0,
          f"PC={int((atype==3).sum())} DD={int((atype==4).sum())} MM={int((atype==1).sum())}")

    au = int("".join(c for c in str(holdout[0]) if c.isdigit()))
    tr_act = AX[(asubj == au) & (asess == 0)]
    te_act = AX[(asubj == au) & (asess == 1)]
    ai_act = AX[(asubj != au)][:400]
    tr_a = post("/api/user/train", {"userId": f"validate-act-{au}",
                                    "actions": tr_act.tolist(), "minActions": 40})
    check("action model trains through the service", tr_a.get("ok") is True,
          str(tr_a.get("error", ""))[:70])
    if tr_a.get("ok"):
        check("negatives drawn from the action pool",
              "dataset" in str(tr_a.get("negativeSource")), str(tr_a.get("negativeSource")))
        check("decision set size is the published 20", tr_a.get("setSize") == 20,
              str(tr_a.get("setSize")))
        pg = post("/api/user/predict", {"userId": f"validate-act-{au}", "actions": te_act.tolist()})
        pi = post("/api/user/predict", {"userId": f"validate-act-{au}", "actions": ai_act.tolist()})
        gs, isc = np.array(pg["scores"]), np.array(pi["scores"])
        check("a score per action returned", len(gs) == len(te_act), f"{len(gs)}/{len(te_act)}")
        eer_a, _ = eer_of(gs, isc)
        auc_a = auc_of(gs, isc)
        print(f"   genuine mean {gs.mean():.3f}  impostor mean {isc.mean():.3f}  "
              f"AUC {auc_a:.3f}  per-action EER {eer_a:.2%}")
        check("action model discriminates", auc_a > 0.6, f"AUC={auc_a:.3f}")
        check("genuine set passes", (not pg["isSuspicious"]), f"setScore={pg['setScore']:.3f}")
        check("impostor set is flagged", pi["isSuspicious"] is True,
              f"setScore={pi['setScore']:.3f}")

print("\n8. Browser/training feature parity")
check("SDK action extractor present", os.path.isfile("/app/sdk/js/mouse-actions.js"))
check("parity checker present", os.path.isfile("/app/tools/action_parity_check.js"))

print("\n" + "=" * 72)
print(f"RESULT: {'ALL CHECKS PASSED' if not FAILS else f'{len(FAILS)} CHECK(S) FAILED'}")
for f in FAILS:
    print("   FAILED:", f)
print("=" * 72)
sys.exit(1 if FAILS else 0)
