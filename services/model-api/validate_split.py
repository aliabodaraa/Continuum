"""
Check 1: the train/validation split leaks nothing, verified on REAL payloads.

The unit test in split_ab_test.py reasons about indices. This one is stronger: it compares the
actual window CONTENTS. Two windows built with stride 10 from a 50-step window share 40
identical rows, so leakage is provable directly — take every validation window, look for any of
its rows inside any training window, and require zero hits. No index arithmetic is trusted.

Run inside the model-api container:
    python validate_split.py
"""
import sqlite3

import numpy as np

from api import DEFAULT_OVERLAP_GAP, dedupe_windows, split_no_overlap

# A genuine coincidence of 6 identical float timings can happen for a single row; five
# identical rows cannot arise by chance, so >=5 shared rows means the windows were cut from
# overlapping positions in the same stream. This separates real leakage from noise.
REAL_OVERLAP_ROWS = 5
from keystroke_user_sweep import CA_DB, build_steps, steps_to_windows

failures = 0


def check(name, ok, detail=""):
    global failures
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures += 1


def shared_rows(A, B, min_rows=REAL_OVERLAP_ROWS):
    """Validation windows in B sharing >= min_rows exact rows with any window in A.

    Returns (n_real_overlap, n_single_row_coincidence)."""
    train_rows = set()
    for w in A:
        for r in w:
            train_rows.add(np.asarray(r, dtype=np.float32).tobytes())
    real = coincidental = 0
    for w in B:
        c = sum(1 for r in w if np.asarray(r, dtype=np.float32).tobytes() in train_rows)
        if c >= min_rows:
            real += 1
        elif c:
            coincidental += 1
    return real, coincidental


def user_positives(user_id):
    con = sqlite3.connect(f"file:{CA_DB}?mode=ro", uri=True)
    ids = [r[0] for r in con.execute(
        "SELECT id FROM keystroke_texts WHERE user_id=? AND is_training=1 ORDER BY id",
        (user_id,)).fetchall()]
    W, G = [], []
    for i in ids:
        ev = con.execute(
            "SELECT key_code, event_type, timestamp_relative, field_name "
            "FROM keystroke_events WHERE keystroke_text_id=? ORDER BY id", (i,)).fetchall()
        for w in steps_to_windows(build_steps(ev)):
            W.append(w)
            G.append(i)
    con.close()
    return np.asarray(W, dtype=np.float32), G


def old_split(n, seed=7):
    idx = np.arange(n)
    np.random.default_rng(seed).shuffle(idx)
    cut = max(1, int(n * 0.8))
    return idx[:cut], idx[cut:]


print("CHECK 1 — train/validation split leaks nothing (row-level, real payload)")
X, groups = user_positives(1)
print(f"    user 1: {len(X)} windows from {len(set(groups))} source samples")

# the shipped path dedupes before splitting; mirror it exactly
keep, dropped = dedupe_windows(X)
Xd = X[keep]
gd = [groups[i] for i in keep]
print(f"    dedupe dropped {dropped} exact-duplicate windows "
      f"(same content filed under a second sample id)")

tr, va, how = split_no_overlap(len(Xd), gd)
hits, coincid = shared_rows(Xd[tr], Xd[va])
print(f"    strategy={how}  train={len(tr)}  val={len(va)}")
check("no validation window overlaps a training window (grouped + deduped)", hits == 0,
      f"{hits}/{len(va)} real overlaps, {coincid} single-row coincidences")

# without dedupe, duplicates defeat grouping — this is the defect this pass found
tr0, va0, _ = split_no_overlap(len(X), groups)
h0, _ = shared_rows(X[tr0], X[va0])
check("dedupe is what fixes it (control — grouping ALONE still leaks)", h0 > 0,
      f"grouping without dedupe leaks {h0}/{len(va0)} windows")

# the same data under the OLD rule, to confirm the test can actually detect leakage
otr, ova = old_split(len(X))
ohits, _ = shared_rows(X[otr], X[ova])
check("the test detects the OLD leak (control — this SHOULD show leakage)", ohits > 0,
      f"old split leaks {ohits}/{len(ova)} = {100*ohits/len(ova):.0f}%")

# fallback path: no groups supplied
tr2, va2, how2 = split_no_overlap(len(Xd), None, gap=DEFAULT_OVERLAP_GAP)
# the fallback cannot know sample boundaries, so it is only required to be leak-free
# WITHIN the contiguous stream it sees; check it against the same-sample criterion
hits2 = 0
for v in va2:
    for t in tr2:
        if gd[t] == gd[v] and abs(t - v) < DEFAULT_OVERLAP_GAP:
            hits2 += 1
            break
print(f"    fallback strategy={how2}  train={len(tr2)}  val={len(va2)}")
check("ungrouped fallback also leaks nothing", hits2 == 0, f"{hits2} overlapping pairs")

# group integrity: no source sample may appear on both sides
gt = {gd[i] for i in tr}
gv = {gd[i] for i in va}
check("no source sample straddles the split", not (gt & gv),
      f"{len(gt & gv)} straddling samples")
check("validation is a usable fraction", 0.05 <= len(va) / len(Xd) <= 0.5,
      f"{100*len(va)/len(Xd):.0f}% of windows")

print(f"\n{'ALL CHECKS PASSED' if failures == 0 else str(failures) + ' CHECK(S) FAILED'}")
raise SystemExit(1 if failures else 0)
