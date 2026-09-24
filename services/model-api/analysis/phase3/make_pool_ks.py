"""Draw the Aalto negative pools for experiment KS (PREREGISTRATION_KS.md section 3).

    python make_pool_ks.py            # data/Keystrokes.zip -> data/aalto_pool_ks.h5 + artifacts/phase3/aalto_pool_ks.json

Reads the Aalto zip directly (no 16 GB unzip). Every participant file (`<id>_keystrokes.txt`) is
listed, sorted by participant id and permuted with default_rng(20260924). Files are then read in
that order with aalto_to_windows.participant_windows (the converter checked for parity with the live
code), and a participant is kept if they yield at least 10 windows, until 1,000 are kept. A40 = the
first 40 kept, A200 = the first 200, A1000 = all 1,000. Only these 1,000 participants are
ever converted. No KeyRecs file is read here.
"""
import argparse
import os
import re
import sys
import tempfile
import zipfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ks_common as KC  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY: skips the freeze check")
    ap.add_argument("--zip", default=KC.AALTO_ZIP)
    ap.add_argument("--out", default=None)
    ap.add_argument("--want", type=int, default=max(KC.POOL_SIZES.values()))
    a = ap.parse_args()
    hashes = {} if a.smoke else KC.verify_frozen()
    if a.smoke:
        os.makedirs(KC.SMOKE, exist_ok=True)
    out = a.out or (os.path.join(KC.SMOKE, "aalto_pool_ks.h5") if a.smoke else KC.POOL)
    manifest = os.path.join(KC.SMOKE if a.smoke else KC.STUDY, "aalto_pool_ks.json")
    if not a.smoke and os.path.exists(manifest):
        raise SystemExit(f"{manifest} exists already; the pool is drawn once")
    from aalto_to_windows import participant_windows
    import h5py

    z = zipfile.ZipFile(a.zip)
    members = {}
    for name in z.namelist():
        m = re.search(r"(?:^|/)(\d+)_keystrokes\.txt$", name)
        if m:
            members[int(m.group(1))] = name
    ids = np.array(sorted(members), np.int64)
    order = ids[np.random.default_rng(KC.POOL_SEED).permutation(len(ids))]
    print(f"[KS-pool] {len(ids)} participant files; drawing until {a.want} have >= {KC.MIN_POOL_WINDOWS} windows", flush=True)
    kept, W, P, S, scanned, counts = [], [], [], [], 0, []
    with tempfile.TemporaryDirectory() as tmp:
        for pid in order:
            scanned += 1
            path = os.path.join(tmp, "p.txt")
            with z.open(members[int(pid)]) as src, open(path, "wb") as dst:
                dst.write(src.read())
            got, wins, secs, _ = participant_windows(path)
            if got is None or int(got) != int(pid) or len(wins) < KC.MIN_POOL_WINDOWS:
                continue
            kept.append(int(pid)); counts.append(len(wins))
            W.extend(wins); P.extend([int(pid)] * len(wins)); S.extend(secs)
            if len(kept) % 100 == 0:
                print(f"  {len(kept)} kept of {scanned} read", flush=True)
            if len(kept) >= a.want:
                break
    if len(kept) < a.want:
        print(f"[KS-pool] only {len(kept)} eligible participants: the largest arm uses all of them (section 3)")
    with h5py.File(out + ".tmp", "w") as f:
        f.create_dataset("windows", data=np.asarray(W, np.float32), compression="gzip")
        f.create_dataset("participant", data=np.asarray(P, np.int64), compression="gzip")
        f.create_dataset("section", data=np.asarray(S, np.int64), compression="gzip")
        f.create_dataset("drawOrder", data=np.asarray(kept, np.int64))
    os.replace(out + ".tmp", out)
    KC.write_json(manifest, {**hashes, "smokeTest": a.smoke, "seed": KC.POOL_SEED,
                             "minWindows": KC.MIN_POOL_WINDOWS, "filesListed": int(len(ids)),
                             "filesRead": scanned, "kept": kept, "windowsPerKept": counts,
                             "poolH5": os.path.relpath(out, KC.ROOT).replace(os.sep, "/"), "poolH5Sha256": KC.sha(out)},
                  indent=1)
    print(f"[KS-pool] kept {len(kept)} of {scanned} read ({sum(counts)} windows) -> {out}")


if __name__ == "__main__":
    main()
