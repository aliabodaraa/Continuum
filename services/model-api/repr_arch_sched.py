"""
Memory-aware scheduler for the repr/arch study jobs (replaces xargs -P for heavy queues).

A job is launched only when (a) fewer than --max-jobs study jobs are running and (b) the VM's
MemAvailable exceeds that job's expected footprint plus --reserve-gb. A job is skipped when its
result file exists or when an identical job is already running (so it can take over from an
earlier driver mid-queue without duplicating work). Settings of each job are identical to
run_repr_arch.sh; only the launch timing changes.

    python repr_arch_sched.py --exp B --rep A5 --max-jobs 8 --threads 4
"""
import argparse
import os
import subprocess
import time

ROOT = "/app/artifacts/repr_arch_study"
# measured peak RSS of one job, GB (B9 2.3 on the A5 input); unknown arms get the largest
FOOTPRINT_GB = {"B1": 1.4, "B2": 1.4, "B3": 1.5, "B4": 1.0, "B5": 2.6, "B6": 1.6, "B7": 1.0,
                "B8": 1.0, "B9": 2.6}


def mem_available_gb():
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable"):
            return int(line.split()[1]) / 1024 / 1024
    return 0.0


def running_jobs():
    out = set()
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        except OSError:
            continue
        cmd = [c.decode(errors="ignore") for c in cmd]
        if any(c.endswith("repr_arch_study.py") for c in cmd) and "--arm" in cmd:
            out.add((cmd[cmd.index("--exp") + 1], cmd[cmd.index("--arm") + 1],
                     int(cmd[cmd.index("--seed") + 1])))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", default="B")
    ap.add_argument("--rep", default="A5")
    ap.add_argument("--max-jobs", type=int, default=8)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--reserve-gb", type=float, default=1.5)
    args = ap.parse_args()
    arms = [f"B{i}" for i in range(1, 10)]
    queue = [(a, s) for s in (0, 1, 2) for a in arms]
    tag = lambda a, s: f"{args.exp}_{a}_s{s}_{args.rep}"
    while True:
        done = {q for q in queue if os.path.exists(f"{ROOT}/parts/{tag(*q)}.json")}
        run = {(a, s) for (e, a, s) in running_jobs() if e == args.exp}
        todo = [q for q in queue if q not in done and q not in run]
        if not todo and not run:
            print("ALL DONE", flush=True)
            return
        if todo and len(run) < args.max_jobs:
            a, s = todo[0]
            need = FOOTPRINT_GB.get(a, 2.6) + args.reserve_gb
            avail = mem_available_gb()
            if avail >= need:
                log = open(f"{ROOT}/logs/{tag(a, s)}.log", "w")
                subprocess.Popen(["python", "repr_arch_study.py", "--exp", args.exp, "--arm", a,
                                  "--seed", str(s), "--threads", str(args.threads), "--rep", args.rep],
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                 cwd="/app/services/model-api")
                print(f"launched {a} seed {s} (MemAvailable {avail:.1f} GB, need {need:.1f})", flush=True)
                time.sleep(60)          # let it load data before judging memory again
                continue
        time.sleep(30)


if __name__ == "__main__":
    main()
