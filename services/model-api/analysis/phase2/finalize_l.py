"""Protocol L final training and SELECTION_L.json (PREREGISTRATION_L.md section 4, "Final training").

    python finalize_l.py             # status: what exists, what is missing, the commands
    python finalize_l.py --run       # trains the missing final models one after another, then --write
    python finalize_l.py --write     # verifies the three final models and writes SELECTION_L.json

Reads artifacts/phase2/L/selection_scores.json (select_l.py). The winning configuration is retrained on
all 80 base users with seeds 101, 102 and 103, for the epoch count of its selection run (its best
epoch; no early stopping, the whole 3-min session). SELECTION_L.json records the configuration, the
epochs, the selection file's hash and the three model hashes. It is written once. It must exist before
any development user is scored (l_common.guard_users refuses them until then).

    python finalize_l.py --smoke --run    # SMOKE TEST ONLY: 6 users, 2 epochs, under L/smoke/
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402

SMOKE_USERS, SMOKE_EPOCHS = 6, 2


def plan(smoke):
    folder = LC.SMOKE if smoke else LC.OUT
    sel_path = os.path.join(folder, "selection_scores.json")
    if not os.path.exists(sel_path):
        raise SystemExit(f"{sel_path} missing: run select_l.py first")
    hashes = LC.verify_frozen()
    sel = json.load(open(sel_path))
    LC.check_hashes(sel, hashes, sel_path)
    if bool(sel.get("smokeTest")) != smoke:
        raise SystemExit(f"{sel_path}: smokeTest={sel.get('smokeTest')} does not fit this run")
    for c in sel["candidates"]:                       # the scored candidates are the ones on disk
        wp = os.path.join(folder, "models", c["model"], "embedding.weights.h5")
        if not os.path.exists(wp) or LC.sha(wp) != c["weightsSha256"]:
            raise SystemExit(f"{c['model']}: weights missing or changed since select_l.py scored them")
    w = sel["winner"]
    epochs = SMOKE_EPOCHS if smoke else int(w["bestEpoch"])
    if epochs < 1:
        raise SystemExit(f"winner's best epoch is {epochs}: technical failure, re-run its selection training")
    models = []
    for seed in LC.SEEDS:
        name = f"{w['objective']}-{w['param']:g}-base-80-s{seed}-e{epochs}"
        cmd = [sys.executable, os.path.join(HERE, "train_embedding_l.py"), "--objective", w["objective"],
               "--param", f"{w['param']:g}", "--users", "base-80", "--seed", str(seed), "--epochs", str(epochs)]
        if smoke:
            cmd += ["--limit-users", str(SMOKE_USERS)]
        models.append({"seed": seed, "name": name, "dir": os.path.join(folder, "models", name), "cmd": cmd})
    return folder, sel_path, sel, hashes, epochs, models


def verify_model(m, w, epochs, hashes, smoke):
    meta_path = os.path.join(m["dir"], "meta.json")
    if not os.path.exists(meta_path):
        return None, "missing"
    _, meta = LC.load_model_dir(m["dir"], allow_smoke=smoke)
    LC.check_hashes(meta, hashes, m["dir"])
    want = {"objective": w["objective"], "users": "base-80", "seed": m["seed"], "fixedEpochs": epochs}
    bad = {k: (meta.get(k), v) for k, v in want.items() if meta.get(k) != v}
    if abs(float(meta["param"]) - float(w["param"])) > 1e-12:
        bad["param"] = (meta["param"], w["param"])
    if not smoke and meta.get("nUsers") != 80:
        bad["nUsers"] = (meta.get("nUsers"), 80)
    if bad:
        raise SystemExit(f"{m['dir']}: does not match the selection: {bad}")
    return meta, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="train the missing final models, then write")
    ap.add_argument("--write", action="store_true", help="verify the final models and write SELECTION_L.json")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY")
    a = ap.parse_args()

    folder, sel_path, sel, hashes, epochs, models = plan(a.smoke)
    w = sel["winner"]
    target = os.path.join(folder, "SELECTION_L.SMOKE.json") if a.smoke else LC.SELECTION
    if os.path.exists(target) and not a.smoke:
        raise SystemExit(f"{target} exists already; it is written once")
    print(f"[L-final] winner {w['objective']} {w['param']:g}, {epochs} epochs, seeds {list(LC.SEEDS)}")
    for m in models:
        _, status = verify_model(m, w, epochs, hashes, a.smoke)
        print(f"  seed {m['seed']}: {status}  {m['dir']}")
        if status == "missing" and not a.run:
            args = m["cmd"][2:] + (["--threads", str(a.threads)] if a.threads else [])
            print("    python train_embedding_l.py " + " ".join(args))
    if a.run:
        for m in models:
            if verify_model(m, w, epochs, hashes, a.smoke)[1] == "missing":
                cmd = m["cmd"] + (["--threads", str(a.threads)] if a.threads else [])
                print(f"[L-final] training seed {m['seed']} ...", flush=True)
                subprocess.run(cmd, check=True)
    if not (a.run or a.write):
        return
    rec = []
    for m in models:
        meta, status = verify_model(m, w, epochs, hashes, a.smoke)
        if status != "ok":
            raise SystemExit(f"seed {m['seed']}: {status}; not writing {os.path.basename(target)}")
        rec.append({"seed": m["seed"], "dir": os.path.relpath(m["dir"], LC.ROOT).replace(os.sep, "/"),
                    "weightsSha256": meta["weightsSha256"], "metaSha256": LC.sha(os.path.join(m["dir"], "meta.json")),
                    "minutes": meta.get("minutes"), "tensorflow": meta.get("tensorflow")})
    out = {**hashes, "protocol": "L", "stage": "final", "smokeTest": a.smoke,
           "writtenAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "configuration": {"objective": w["objective"], "param": w["param"], "epochs": epochs,
                             "selectionModel": w["model"], "selectionMeanPerUserAuc": w["meanPerUserAuc"]},
           "epochsRule": ("the winner's best epoch in its selection run (early stopping on base-train, 80% of each "
                          "3-min session), applied to all 80 base users and their whole 3-min sessions; one epoch = "
                          "ceil(windows / 256) class-balanced batches of 32 users x 8 windows, so a final epoch has "
                          "more steps than a selection epoch"),
           "selectionScoresSha256": LC.sha(sel_path), "models": rec, "codeSha256": LC.code_hashes(),
           "note": "Written before any development user is scored (PREREGISTRATION_L.md section 4)."}
    LC.write_json(target, out, indent=1)
    print(f"[L-final] wrote {target}")


if __name__ == "__main__":
    main()
