#!/bin/sh
# Driver for repr_arch_study.py. Usage:
#   sh run_repr_arch.sh A [PARALLEL] [THREADS]          # Experiment A: A1..A8 x seeds 0..2
#   sh run_repr_arch.sh B <rep> [PARALLEL] [THREADS]    # Experiment B on the adopted representation
# A job whose result file already exists is skipped, so after an interruption the
# driver is simply started again and only unfinished jobs run. GRU training is sequential,
# so many light jobs use the 32 cores better than a few heavy ones.
set -u
EXP="$1"
if [ "$EXP" = "A" ]; then REP=""; P="${2:-10}"; T="${3:-2}"; ARMS="A1 A2 A3 A4 A5 A6 A7 A8";
else REP="$2"; P="${3:-10}"; T="${4:-2}"; ARMS="B1 B2 B3 B4 B5 B6 B7 B8 B9"; fi
ROOT=/app/artifacts/repr_arch_study
mkdir -p "$ROOT/parts" "$ROOT/logs"
cd /app/services/model-api
for s in 0 1 2; do for a in $ARMS; do
  if [ "$EXP" = "A" ]; then tag="A_${a}_s${s}"; else tag="B_${a}_s${s}_${REP}"; fi
  # Resume rule: a job is done only when its RESULT file exists. A log without a result
  # means the job was interrupted (e.g. the PC shut down) and it is run again from scratch.
  [ -e "$ROOT/parts/${tag}.json" ] || echo "$a $s $ROOT/logs/${tag}.log"
done; done | xargs -P "$P" -n 3 sh -c '
    arm="$0"; seed="$1"; log="$2"
    if [ "'"$EXP"'" = "A" ]; then extra=""; else extra="--rep '"$REP"'"; fi
    python repr_arch_study.py --exp '"$EXP"' --arm "$arm" --seed "$seed" --threads '"$T"' $extra > "$log" 2>&1
    echo "finished $arm seed $seed exit $?"'
echo "ALL DONE $EXP"
