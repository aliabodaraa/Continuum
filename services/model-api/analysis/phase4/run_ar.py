"""Experiment AR: adaptive retraining on KeyRecs' two sessions (PREREGISTRATION_AR.md).

    python run_ar.py --threads 8 --from 0 --to 99      # one JSON per target in artifacts/phase4/parts/

Per target (sections 3-5 of the pre-registration):
  A  the enrolment model (5 samples of 330 steps), never retrained;
  B  the deployed loop: each day's 330-step chunk is scored by the current model and accepted only
     past the server's gates; three accepted -> retrain on enrolment + all accepted;
  C  learn from the lock: a day is added when the live rule locks on it (the genuine user then passes
     the passkey); three added -> retrain;
  D  upper bound: every day added, one retrain at the end;
  R  the enrolment model retrained with another seed and no new data (how much retraining alone moves things);
  S1 would an impostor's typing pass B's gates on this target's enrolment model?
  S2 worst-case poisoning: the most similar impostor's three chunks forced in, one retrain.
A finished target is never trained again (a crash leaves no file). Seeds: 1000 + target (+ an arm offset
+ the retrain number), numpy and TensorFlow, op determinism on.
"""
import argparse
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ar_common as AC  # noqa: E402


def as_list(a):
    return [round(float(v), 6) for v in a]


def run_target(tid, s, sess, K, kpid, imp_pool, NEG, npid, neg_pool, scaler, epochs):
    import tensorflow as tf
    from population_sweep import PACKET_RUN_LEN
    tl = AC.timeline(s)
    if tl is None:
        return None
    enrol, days, test = tl
    enrol_w = [AC.windows(x) for x in enrol]
    day_w = [AC.windows(x) for x in days]
    test_w = AC.windows(test)
    seed0 = 1000 + int(tid)
    imp_runs = {}
    for p in imp_pool:
        if p == tid:
            continue
        run = K[kpid == p][:PACKET_RUN_LEN]
        if len(run) >= 8:
            imp_runs[int(p)] = run

    def fit(pool, seed):
        t0 = time.time()
        m, info = AC.train(pool, seed, NEG, npid, neg_pool, scaler, epochs)
        info["seconds"] = round(time.time() - t0, 2)
        info["seed"] = int(seed)
        return m, info

    def evaluate(model):
        g = AC.score(model, test_w, scaler)
        runs = {str(p): as_list(AC.score(model, W, scaler)) for p, W in imp_runs.items()}
        return {"genuine": as_list(g), "runs": runs, "testLockAt": AC.replay_locks(g)}

    out = {"participant": int(tid), "code": s["code"], "sessionLabels": s["sessionLabels"],
           "nEnrolWindows": int(sum(len(w) for w in enrol_w)), "nDays": len(days),
           "dayWindows": [int(len(w)) for w in day_w], "nTestWindows": int(len(test_w))}

    mA, infoA = fit(enrol_w, seed0 + AC.SEED_OFFSET["A"])
    out["A"] = {"trainings": [infoA], **evaluate(mA)}

    # B and C: walk the days with the model of the moment
    def loop(arm, accept):
        model, pool, hist, pending, trainings, log = mA, list(enrol_w), list(enrol), 0, [], []
        for d, (steps, W) in enumerate(zip(days, day_w)):
            sc = AC.score(model, W, scaler)
            ok, detail = accept(sc, steps, hist)
            log.append({"day": d, "model": len(trainings), "accepted": bool(ok), **detail})
            if ok:
                pool.append(W)
                hist.append(steps)
                pending += 1
                if pending >= AC.RETRAIN_EVERY:
                    model, info = fit(pool, seed0 + AC.SEED_OFFSET[arm] + len(trainings) + 1)
                    info["afterDay"] = d
                    trainings.append(info)
                    pending = 0
        return {"trainings": trainings, "days": log, "pendingUntrained": pending, **evaluate(model)}

    def accept_b(sc, steps, hist):
        ok, reason, rm, worst, z = AC.gate(sc, steps, hist)
        return ok, {"reason": reason, "rollingMean": round(rm, 4), "worstLast6": round(worst, 4), "rhythmZ": round(z, 3)}

    def accept_c(sc, steps, hist):
        locks = AC.replay_locks(sc)
        return bool(locks), {"reason": "lock" if locks else "no-lock", "locksAt": locks}

    out["B"] = loop("B", accept_b)
    out["C"] = loop("C", accept_c)
    mD, infoD = fit(enrol_w + day_w, seed0 + AC.SEED_OFFSET["D"])
    out["D"] = {"trainings": [infoD], **evaluate(mD)}
    mR, infoR = fit(enrol_w, seed0 + AC.SEED_OFFSET["R"])
    out["R"] = {"trainings": [infoR], **evaluate(mR)}

    # S1: the gates on the enrolment model -- each day of the target (genuine) vs each impostor's first chunk
    gen_pass = []
    for steps, W in zip(days, day_w):
        ok, reason, *_ = AC.gate(AC.score(mA, W, scaler), steps, enrol)
        gen_pass.append({"accepted": bool(ok), "reason": reason})
    imp_pass = {}
    for p in imp_runs:
        st = sess[p]["steps"][0][:AC.SAMPLE_STEPS]
        if len(st) < AC.SAMPLE_STEPS:
            continue
        ok, reason, rm, worst, z = AC.gate(AC.score(mA, AC.windows(st), scaler), st, enrol)
        imp_pass[str(p)] = {"accepted": bool(ok), "reason": reason, "rollingMean": round(rm, 4), "rhythmZ": round(z, 3)}
    out["S1"] = {"genuineDays": gen_pass, "impostorChunks": imp_pass}

    # S2: the most similar impostor (highest mean A score on their 150-window run) forces three chunks in
    ranked = sorted(imp_runs, key=lambda p: (-float(np.mean(AC.score(mA, imp_runs[p], scaler))), p))
    attacker = next((p for p in ranked if len(sess[p]["steps"]) == 2 and
                     len(sess[p]["steps"][1]) >= 3 * AC.SAMPLE_STEPS + 500), None)
    if attacker is not None:
        s2 = sess[attacker]["steps"][1]
        poison = [AC.windows(s2[k * AC.SAMPLE_STEPS:(k + 1) * AC.SAMPLE_STEPS]) for k in range(3)]
        att_test = AC.windows(s2[3 * AC.SAMPLE_STEPS:])
        gates = [AC.gate(AC.score(mA, w, scaler), s2[k * AC.SAMPLE_STEPS:(k + 1) * AC.SAMPLE_STEPS], enrol)[:2]
                 for k, w in enumerate(poison)]
        mP, infoP = fit(enrol_w + poison, seed0 + AC.SEED_OFFSET["S2"])
        out["S2"] = {"attacker": int(attacker), "trainings": [infoP],
                     "poisonWouldPassGates": [bool(g[0]) for g in gates], "poisonGateReasons": [g[1] for g in gates],
                     "attackerTestBefore": as_list(AC.score(mA, att_test, scaler)),
                     "attackerTestAfter": as_list(AC.score(mP, att_test, scaler)),
                     "genuineTestAfter": as_list(AC.score(mP, test_w, scaler))}
    else:
        out["S2"] = None
    tf.keras.backend.clear_session()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--from", dest="lo", type=int, default=0)
    ap.add_argument("--to", dest="hi", type=int, default=10 ** 6)
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY: skips the freeze check")
    ap.add_argument("--epochs", type=int, default=AC.EPOCHS, help="30 (frozen); smoke tests may lower it")
    a = ap.parse_args()
    if a.epochs != AC.EPOCHS and not a.smoke:
        raise SystemExit("--epochs is for smoke tests only")
    hashes = {} if a.smoke else AC.verify_frozen()

    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    tf.config.experimental.enable_op_determinism()

    K, kpid = AC.load_h5(AC.KEYRECS_H5)
    sess = AC.load_sessions()
    AC.check_parity(sess, K, kpid)
    ids, imp_pool = AC.impostor_pool(kpid)
    NEG, npid, neg_pool = AC.load_negatives(a.smoke)
    scaler = AC.load_scaler()
    out_dir = os.path.join(AC.SMOKE if a.smoke else AC.STUDY, "parts")
    os.makedirs(out_dir, exist_ok=True)
    targets = [int(t) for t in ids if a.lo <= int(t) < a.hi]
    print(f"[AR] {len(targets)} targets, {len(neg_pool)} Aalto negative typists, {len(imp_pool)} impostors", flush=True)
    for tid in targets:
        path = os.path.join(out_dir, f"{tid}.json")
        if os.path.exists(path) and not a.smoke:
            continue
        t0 = time.time()
        r = run_target(tid, sess[tid], sess, K, kpid, imp_pool, NEG, npid, neg_pool, scaler, a.epochs)
        AC.write_json(path, {**hashes, "smokeTest": a.smoke, "eligible": r is not None, **(r or {"participant": tid})})
        if r:
            print(f"  {tid:>3} {r['code']}: days {r['nDays']}, test {r['nTestWindows']} win | B accepted "
                  f"{sum(d['accepted'] for d in r['B']['days'])} ({len(r['B']['trainings'])} retrains) | C accepted "
                  f"{sum(d['accepted'] for d in r['C']['days'])} ({len(r['C']['trainings'])}) | {time.time() - t0:.0f} s", flush=True)
        else:
            print(f"  {tid:>3}: not eligible", flush=True)


if __name__ == "__main__":
    main()
