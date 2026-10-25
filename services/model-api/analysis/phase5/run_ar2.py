"""Experiment AR2: adaptive retraining with the sample rule as built (PREREGISTRATION_AR2.md).

    python run_ar2.py --threads 8 --from 0 --to 99      # one JSON per target in artifacts/phase5/parts/

Per target (sections 3-5 of the pre-registration), on AR's timeline and recipe:
  A     the enrolment model (5 samples of 330 steps), never retrained;
  B     the loop as built: each day's 330-step chunk (29 windows) is offered; its sample is the LAST 20 windows;
        accepted if their mean >= 0.80, each of the newest 3 >= 0.80 and the rhythm is consistent; only those
        20 windows are learned; three accepted samples -> retrain on enrolment + all accepted samples;
  B1    the same, retrain after one accepted sample;   B2: after two;
  Bany  the same as B, but the sample is the newest run of 20 windows of the chunk that passes the score checks;
  D     upper bound: every day added (all its windows), one retrain at the end;
  R     the enrolment model retrained with another seed and no new data (noise reference);
  S1    would genuine days and impostor chunks be accepted (end and any) on this target's enrolment model?
  S2    worst-case poisoning: the most similar impostor's three chunks forced in (their last 20 windows each);
  S3    a takeover at the end: the last 1-3 windows of a genuine day replaced by an impostor's.
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
import ar2_common as C2  # noqa: E402

AC = C2.AC


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
        return {"genuine": as_list(g), "runs": runs, "testLockAt": C2.replay_locks(g)}

    out = {"participant": int(tid), "code": s["code"], "sessionLabels": s["sessionLabels"],
           "nEnrolWindows": int(sum(len(w) for w in enrol_w)), "nDays": len(days),
           "dayWindows": [int(len(w)) for w in day_w], "nTestWindows": int(len(test_w))}

    mA, infoA = fit(enrol_w, seed0 + C2.SEED_OFFSET["A"])
    out["A"] = {"trainings": [infoA], **evaluate(mA)}

    def loop(arm):
        every, mode = C2.VARIANTS[arm]
        model, pool, hist, pending, trainings, log = mA, list(enrol_w), list(enrol), 0, [], []
        for d, (steps, W) in enumerate(zip(days, day_w)):
            sc = AC.score(model, W, scaler)
            g = C2.sample_gate(sc, steps, hist, mode)
            log.append({"day": d, "model": len(trainings), **g})
            if g["accepted"]:
                pool.append(C2.sample_windows(W, g["start"]))
                hist.append(C2.sample_steps(steps, g["start"]))
                pending += 1
                if pending >= every:
                    model, info = fit(pool, seed0 + C2.SEED_OFFSET[arm] + len(trainings) + 1)
                    info["afterDay"] = d
                    trainings.append(info)
                    pending = 0
        return {"trainings": trainings, "days": log, "pendingUntrained": pending, **evaluate(model)}

    for arm in ("B", "B1", "B2", "Bany"):
        out[arm] = loop(arm)
    mD, infoD = fit(enrol_w + day_w, seed0 + C2.SEED_OFFSET["D"])
    out["D"] = {"trainings": [infoD], **evaluate(mD)}
    mR, infoR = fit(enrol_w, seed0 + C2.SEED_OFFSET["R"])
    out["R"] = {"trainings": [infoR], **evaluate(mR)}

    # S1: the rule on the enrolment model -- each day of the target (genuine) vs each impostor's first chunk
    gen_pass = []
    for steps, W in zip(days, day_w):
        sc = AC.score(mA, W, scaler)
        gen_pass.append({m: C2.sample_gate(sc, steps, enrol, m) for m in ("end", "any")})
    imp_pass, imp_scores = {}, {}
    for p in imp_runs:
        st = sess[p]["steps"][0][:AC.SAMPLE_STEPS]
        if len(st) < AC.SAMPLE_STEPS:
            continue
        sc = AC.score(mA, AC.windows(st), scaler)
        imp_scores[p] = sc
        imp_pass[str(p)] = {m: C2.sample_gate(sc, st, enrol, m) for m in ("end", "any")}
    out["S1"] = {"genuineDays": gen_pass, "impostorChunks": imp_pass}

    # S2: the most similar impostor (highest mean A score on their 150-window run) forces three chunks in
    ranked = sorted(imp_runs, key=lambda p: (-float(np.mean(AC.score(mA, imp_runs[p], scaler))), p))
    attacker = next((p for p in ranked if len(sess[p]["steps"]) == 2 and
                     len(sess[p]["steps"][1]) >= 3 * AC.SAMPLE_STEPS + 500), None)
    if attacker is not None:
        s2 = sess[attacker]["steps"][1]
        chunks = [s2[k * AC.SAMPLE_STEPS:(k + 1) * AC.SAMPLE_STEPS] for k in range(3)]
        att_test = AC.windows(s2[3 * AC.SAMPLE_STEPS:])
        gates = [C2.sample_gate(AC.score(mA, AC.windows(c), scaler), c, enrol, "end") for c in chunks]
        poison = [C2.sample_windows(AC.windows(c), len(AC.windows(c)) - C2.SAMPLE_WINDOWS) for c in chunks]
        mP, infoP = fit(enrol_w + poison, seed0 + C2.SEED_OFFSET["S2"])
        out["S2"] = {"attacker": int(attacker), "trainings": [infoP],
                     "poisonWouldPassGates": [bool(g["accepted"]) for g in gates],
                     "poisonGateReasons": [g["reason"] for g in gates],
                     "attackerTestBefore": as_list(AC.score(mA, att_test, scaler)),
                     "attackerTestAfter": as_list(AC.score(mP, att_test, scaler)),
                     "genuineTestAfter": as_list(AC.score(mP, test_w, scaler))}
    else:
        out["S2"] = None

    # S3: a takeover at the end. The last t windows of a genuine day are an impostor's (their first chunk's
    # last t windows), t = 1..3; t = 0 is the day itself. The score checks only (mean, newest 3), on the end sample.
    s3 = {str(t): {"n": 0, "final": 0, "meanOnly": 0} for t in (0, 1, 2, 3)}
    for steps, W in zip(days, day_w):
        g = AC.score(mA, W, scaler)
        for t in (0, 1, 2, 3):
            for sc in ([None] if t == 0 else list(imp_scores.values())):
                mix = g.copy()
                if t:
                    mix[-t:] = sc[-t:]
                blk = mix[-C2.SAMPLE_WINDOWS:]
                s3[str(t)]["n"] += 1
                s3[str(t)]["final"] += int(C2.scores_ok(blk))
                s3[str(t)]["meanOnly"] += int(blk.mean() >= C2.MEAN_MIN)
    out["S3"] = s3
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
    hashes = {} if a.smoke else C2.verify_frozen()

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
    out_dir = os.path.join(C2.SMOKE if a.smoke else C2.STUDY, "parts")
    os.makedirs(out_dir, exist_ok=True)
    targets = [int(t) for t in ids if a.lo <= int(t) < a.hi]
    print(f"[AR2] {len(targets)} targets, {len(neg_pool)} Aalto negative typists, {len(imp_pool)} impostors", flush=True)
    for tid in targets:
        path = os.path.join(out_dir, f"{tid}.json")
        if os.path.exists(path) and not a.smoke:
            continue
        t0 = time.time()
        r = run_target(tid, sess[tid], sess, K, kpid, imp_pool, NEG, npid, neg_pool, scaler, a.epochs)
        AC.write_json(path, {**hashes, "smokeTest": a.smoke, "eligible": r is not None, **(r or {"participant": tid})})
        if r:
            acc = lambda arm: f"{sum(d['accepted'] for d in r[arm]['days'])} ({len(r[arm]['trainings'])} retrains)"  # noqa: E731
            print(f"  {tid:>3} {r['code']}: days {r['nDays']}, test {r['nTestWindows']} win | B {acc('B')} | B1 {acc('B1')} | "
                  f"B2 {acc('B2')} | Bany {acc('Bany')} | {time.time() - t0:.0f} s", flush=True)
        else:
            print(f"  {tid:>3}: not eligible", flush=True)


if __name__ == "__main__":
    main()
