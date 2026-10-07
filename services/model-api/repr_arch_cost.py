"""
Pre-registered cost endpoint for the representation/architecture study: CPU inference time of
one production check (a batch of 20 windows, ca-service MOUSE_SUSTAIN_WINDOW), per-user
parameters and serialised model size, for every Experiment A and Experiment B arm.

Timing depends only on the architecture and the input width, not on trained weights, so the
personalised network is built untrained. TensorFlow is pinned to ONE thread so the numbers are
comparable across arms and reproducible on another machine; run it while the CPU is otherwise idle.

    python repr_arch_cost.py --out /app/artifacts/repr_arch_study/cost_benchmark.json
"""
import argparse
import json
import os
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/app/artifacts/repr_arch_study/cost_benchmark.json")
    ap.add_argument("--reps", type=int, default=200)
    args = ap.parse_args()

    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(1)
    tf.config.threading.set_inter_op_parallelism_threads(1)
    from repr_arch_study import build, ARCHS, REPRESENTATIONS, WS

    def bench(arch, n_feat):
        tf.keras.backend.clear_session()
        m = build(arch, (WS, n_feat), 2)
        x = np.random.default_rng(0).normal(size=(20, WS, n_feat)).astype(np.float32)
        call = tf.function(lambda t: m(t, training=False))
        for _ in range(10):                                   # warm-up / tracing
            call(x); m.predict(x, verbose=0)
        t_call, t_pred = [], []
        for _ in range(args.reps):
            t0 = time.perf_counter(); call(x).numpy(); t_call.append(time.perf_counter() - t0)
        for _ in range(max(20, args.reps // 5)):
            t0 = time.perf_counter(); m.predict(x, verbose=0); t_pred.append(time.perf_counter() - t0)
        # Weights only: RUMBA's sum-over-time Lambda cannot be serialised as a full model,
        # and the weights are what a deployment ships per user anyway.
        with tempfile.NamedTemporaryFile(suffix=".h5", delete=False) as f:
            path = f.name
        m.save_weights(path)
        size = os.path.getsize(path); os.remove(path)
        return {"params": int(m.count_params()), "weightBytes": int(size),
                "msPerCheckGraph": float(np.median(t_call) * 1000),
                "msPerCheckPredict": float(np.median(t_pred) * 1000)}

    out = {"note": "one production check = 20 windows; TF single-threaded; untrained weights",
           "A": {}, "B": {}}
    for rep, (desc, src, nf, _) in REPRESENTATIONS.items():
        out["A"][rep] = {"desc": desc, "nFeatures": nf, **bench("B1", nf)}
        print(f"A {rep} F={nf}: {out['A'][rep]}")
    for nf in sorted({v[2] for v in REPRESENTATIONS.values()}):
        for arch, (desc, src, _) in ARCHS.items():
            out["B"].setdefault(str(nf), {})[arch] = {"desc": desc, **bench(arch, nf)}
            print(f"B {arch} F={nf}: {out['B'][str(nf)][arch]}")
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
