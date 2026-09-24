"""Protocol L, stage D scoring (PREREGISTRATION_L.md sections 2, 3 and 6).

    python score_l.py              # needs SELECTION_L.json -> artifacts/phase2/L/scores_D.json
    python score_l.py --smoke      # SMOKE TEST ONLY (see below)

Systems, all on the same windows (section 3):
  REF   S1: the stored P3 streams at E = 440 (Method B, base-80 network), one unit per sample order (3).
  F2    the frozen base-80 network (GAP output) + the per-user logistic head.
  L     each final protocol-L model (seeds 101, 102, 103) + the same head.
  Lcos  the same models, cosine to the enrolment centroid (section 3: reported for reference only).
Targets: the development users with at least 440 enrolment windows (19); impostors: the first 150
windows of every other development user's 1-min session (user98 is an impostor only). Cohort: the 80
base users. Every stream F2 and L produce is checked against REF's: same targets, same genuine length,
same impostor ids and run lengths, so all systems see the same windows.

--smoke: base-val users stand in for the targets (5) and impostors (6), 24 base-train users are the
cohort, the smoke selection (L/smoke/SELECTION_L.SMOKE.json) supplies the models, and REF comes from
synthetic records written in protocol_j_p3.py's format. It reads no development or lockbox user.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402


def hashes_j():
    """The protocol-J hashes the P3 records carry (protocol_j_common.verify_frozen)."""
    want = {}
    for line in open(LC.PREREG_J_SHA):
        if line.strip():
            h, name = line.split()
            want[os.path.basename(name)] = h
    got = {"preregistrationJSha256": LC.sha(os.path.join(LC.STUDY, "PREREGISTRATION_J.md")),
           "splitJSha256": LC.sha(LC.HASHED["SPLIT_J.json"])}
    if got["preregistrationJSha256"] != want.get("PREREGISTRATION_J.md") or got["splitJSha256"] != want.get("SPLIT_J.json"):
        raise SystemExit("PREREGISTRATION_J.md or SPLIT_J.json does not match PREREGISTRATION_J.sha256")
    return got


def dir_sha(path):
    """One hash for a SavedModel folder: the files' hashes in sorted relative-path order."""
    import hashlib
    h = hashlib.sha256()
    for base, _, files in sorted(os.walk(path)):
        for f in sorted(files):
            p = os.path.join(base, f)
            h.update(os.path.relpath(p, path).replace(os.sep, "/").encode())
            h.update(LC.sha(p).encode())
    return h.hexdigest()


def ref_units(p3_dir, targets, hj, smoke=False):
    """REF = S1 at E = 440: {"o0"|"o1"|"o2": {target: unit}} from protocol_j_p3.py records."""
    out = {}
    for u in targets:
        path = os.path.join(p3_dir, f"{u}.json")
        if not os.path.exists(path):
            raise SystemExit(f"{path} missing")
        r = json.load(open(path))
        LC.check_hashes(r, hj, path)
        if r.get("phase") != "P3" or r.get("participant") != u:
            raise SystemExit(f"{path}: not the P3 record of {u}")
        if bool(r.get("smokeTest")) != smoke:
            raise SystemExit(f"{path}: smokeTest={r.get('smokeTest')} does not fit this run")
        ents = r["budgets"][str(LC.BUDGET)]
        if len(ents) != 3 or any(e["method"] != "B" for e in ents):
            raise SystemExit(f"{path}: expected 3 Method-B sample orders at E = {LC.BUDGET}")
        for oi, e in enumerate(ents):
            m, oof = e["model"], np.asarray(e["oof"], float)
            if len(oof) != LC.BUDGET or not np.isfinite(oof).all():
                raise SystemExit(f"{path}: order {oi}: incomplete leave-one-sample-out scores")
            out.setdefault(f"o{oi}", {})[u] = {
                "genuine": np.asarray(m["genuine"], float),
                "runs": {o: np.asarray(x, float) for o, x in m["impostor"].items()},
                "ref": oof, "tau": float(np.percentile(oof, LC.Q_TAU))}
    for oi, units in out.items():
        LC.check_finite(units, f"REF {oi}")
    return out


def same_streams(ref, other, what):
    """Section 3: within a stage all systems share the same test windows and impostor runs."""
    for u, d in ref.items():
        o = other[u]
        if len(o["genuine"]) != len(d["genuine"]):
            raise SystemExit(f"{what} {u}: {len(o['genuine'])} genuine windows vs REF's {len(d['genuine'])}")
        if set(o["runs"]) != set(d["runs"]):
            raise SystemExit(f"{what} {u}: impostor set differs from REF's "
                             f"({sorted(set(o['runs']) ^ set(d['runs']))[:4]})")
        for k, v in d["runs"].items():
            if len(o["runs"][k]) != len(v):
                raise SystemExit(f"{what} {u}: run {k} has {len(o['runs'][k])} windows vs REF's {len(v)}")


def write_smoke_p3(folder, units_by_order, hj):
    """Synthetic REF records in protocol_j_p3.py's layout (smoke test only)."""
    os.makedirs(folder, exist_ok=True)
    targets = list(units_by_order[0])
    for u in targets:
        ents = []
        for oi, units in enumerate(units_by_order):
            d = units[u]
            ents.append({"order": [(oi + i) % 8 for i in range(8)], "method": "B",
                         "model": {"genuine": [round(float(v), 6) for v in d["genuine"]],
                                   "impostor": {o: [round(float(v), 6) for v in x] for o, x in d["runs"].items()},
                                   "info": {"smoke": True}},
                         "oof": [round(float(v), 6) for v in d["ref"]]})
        rec = {**hj, "phase": "P3", "participant": u, "smokeTest": True, "budgets": {str(LC.BUDGET): ents}}
        json.dump(rec, open(os.path.join(folder, f"{u}.json"), "w"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--amended", default=None, help="the amendment that changed code frozen in SELECTION_L.json")
    a = ap.parse_args()

    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    hashes = LC.verify_frozen()
    hj = hashes_j()
    folder = LC.SMOKE if a.smoke else LC.OUT
    path = os.path.join(folder, "scores_D.json")
    if not a.smoke and os.path.exists(path):
        raise SystemExit(f"{path} exists already; stage D is scored once")
    sel_path = os.path.join(LC.SMOKE, "SELECTION_L.SMOKE.json") if a.smoke else LC.SELECTION
    sel = LC.load_selection(sel_path, allow_smoke=a.smoke)
    code = LC.check_code(sel, a.amended)
    j, l = LC.splits()
    scale = LC.load_scaler()

    if a.smoke:
        W = LC.Windows("stage D smoke")
        pool = list(l["baseVal"][:6])
        targets = pool[:5]
        cohort = list(l["baseTrain"][:24])
        p3_dir = os.path.join(LC.SMOKE, "parts", "J_P3")
    else:
        W = LC.Windows("stage D")                      # guard_users: allowed now SELECTION_L.json exists
        dev = list(j["development"])
        targets = sorted([u for u in dev if len(W.get(u, "long")) >= LC.BUDGET], key=lambda u: int(u[4:]))
        pool = [u for u in dev if len(W.get(u, "short"))]
        cohort = LC.base80_users()
        p3_dir = LC.P3_PARTS
        have = sorted(f[:-5] for f in os.listdir(p3_dir) if f.endswith(".json"))
        if sorted(targets) != sorted(have):
            raise SystemExit(f"targets {len(targets)} vs P3 records {len(have)}: {sorted(set(targets) ^ set(have))}")
        if len(targets) != 19 or "user98" in targets or "user98" not in pool:
            raise SystemExit(f"section 2 names 19 targets + user98 as impostor only; found {len(targets)} targets "
                             f"(user98 target: {'user98' in targets}, impostor: {'user98' in pool}). Stop and "
                             "write this up before scoring.")
    print(f"[L-score] {'SMOKE ' if a.smoke else ''}stage D: {len(targets)} targets, {len(pool)} impostor users, "
          f"cohort {len(cohort)}", flush=True)

    systems, models = {}, {}
    emb = LC.base80_embedder(scale)
    systems["F2"] = {"base80": LC.score_targets(emb, W, targets, pool, cohort)}
    LC.check_finite(systems["F2"]["base80"], "F2")
    models["base80"] = {"dir": os.path.relpath(LC.BASE80, LC.ROOT).replace(os.sep, "/"), "sha256": dir_sha(LC.BASE80)}
    print("[L-score] F2 done", flush=True)

    if a.smoke:  # synthetic REF: F2's scores with a little noise per order, in P3's layout
        rng = np.random.default_rng(3)
        f2 = systems["F2"]["base80"]
        noisy = []
        for _ in range(3):
            n = lambda x: np.clip(np.asarray(x) + rng.normal(0, 0.03, len(x)), 0, 1)  # noqa: E731
            noisy.append({u: {"genuine": n(d["genuine"]), "runs": {o: n(v) for o, v in d["runs"].items()},
                              "ref": n(d["ref"])} for u, d in f2.items()})
        write_smoke_p3(p3_dir, noisy, hj)
    systems["REF"] = ref_units(p3_dir, targets, hj, smoke=a.smoke)
    for v in systems["REF"].values():
        same_streams(v, systems["F2"]["base80"], "F2")
    print("[L-score] REF loaded (3 sample orders), streams match F2's", flush=True)

    systems["L"], systems["Lcos"] = {}, {}
    for m in sel["models"]:
        d = os.path.join(LC.ROOT, m["dir"])
        model, meta = LC.load_model_dir(d, allow_smoke=a.smoke)
        LC.check_hashes(meta, hashes, d)
        units, cent = LC.score_targets(LC.embedder_from(model, scale), W, targets, pool, cohort, centroid=True)
        LC.check_finite(units, f"L s{m['seed']}")
        LC.check_finite(cent, f"Lcos s{m['seed']}")
        same_streams(systems["REF"]["o0"], units, f"L s{m['seed']}")
        systems["L"][f"s{m['seed']}"], systems["Lcos"][f"s{m['seed']}"] = units, cent
        models[f"s{m['seed']}"] = {"dir": m["dir"], "weightsSha256": meta["weightsSha256"]}
        print(f"[L-score] L seed {m['seed']} done", flush=True)

    out = {**hashes, "protocol": "L", "stage": "D", "smokeTest": a.smoke, "selectionSha256": LC.sha(sel_path),
           "targets": targets, "impostorPool": pool, "cohortSize": len(cohort),
           "budget": LC.BUDGET, "models": models, "code": code,
           "precision": "REF streams as stored by protocol J (6 decimals); F2, L and Lcos at full float precision",
           "systems": {s: {v: LC.units_to_json(u) for v, u in vs.items()} for s, vs in systems.items()}}
    os.makedirs(folder, exist_ok=True)
    LC.write_json(path, out)
    print(f"[L-score] wrote {path}")


if __name__ == "__main__":
    main()
