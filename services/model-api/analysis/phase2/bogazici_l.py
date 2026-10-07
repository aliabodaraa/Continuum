"""Bogazici Mouse Dynamics Dataset reader for protocol L, stage C (Amendment L-1).

Source: Kilic, Yildirim & Anarim, Data in Brief 36, 107094 (2021); data doi:10.17632/w6cxr8yc7p.2,
CC BY 4.0. Layout (archive listing, 24 Sep): boun-mouse-dynamics-dataset/labels.csv and
users/user1..user19/{training, internal_tests, external_tests}/session_<id>.csv. Training holds each
user's 10 most active days, one session per day; test sessions hold 30-100 actions from the remaining
days. labels.csv (index, session file, label) has no header row: label 0 = the session belongs to the
folder's user, 1 = another user's session (internal users in internal_tests, the 5 external users in
external_tests). Each row: client_timestamp (float seconds since the epoch, UTC), x, y, button, state,
window (an application category).

    python bogazici_l.py --inspect      # structure, counts and window counts only: no model, no score

Mapping to the deployed input (Amendment L-1):
  * (t_ms, button, state, x, y): timestamp x 1000; states Move, Drag, Pressed and Released kept as they
    are (SapiMouse's vocabulary), any other state read as a movement; button None -> "NoButton".
  * Browser emulation: the deployed channel receives browser pointer events, which Chrome delivers once
    per display frame. The logger recorded OS events, so movement events are coalesced to the last one
    in each 1/60-s frame; press and release events are always kept. SapiMouse was recorded in a browser.
  * Windows = repr_arch_study.windows(raw_steps(...), 1.0, "A5"), the deployed A5 windows, built per
    session file: no window or decision spans two sessions.
Selection (Amendment L-1): see target_index() and load().
Inspection (bogazici_inspect.json, 25 Sep): 157,187 labelled test files (94,286 label 0, 62,901 label 1), every
test file labelled once, file names unique. Each user's internal_tests and external_tests hold the SAME number of
label-0 files: the user's genuine sessions are stored in both folders under different names. A session is
therefore identified by its first timestamp, and sampling draws distinct sessions (_pick).
"""
import argparse
import collections
import csv
import glob
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402

ROOT_B = os.path.join(LC.ROOT, "data", "bogazici", "extracted", "boun-mouse-dynamics-dataset")
LAYOUT_CONFIRMED = True           # Amendment L-1 frozen (25 Sep 2026), after the structure-only inspection
TRAIN, INTERNAL, EXTERNAL = "training", "internal_tests", "external_tests"
FRAME_MS = 1000.0 / 60.0
MAX_GENUINE_SESSIONS, MAX_IMPOSTOR_SESSIONS, IMP_RUN = 200, 200, 150
SAMPLE_SEED = 20260925
PRESS, RELEASE = "Pressed", "Released"
STATE = {"press": PRESS, "pressed": PRESS, "release": RELEASE, "released": RELEASE, "drag": "Drag", "move": "Move"}
# The real files (5 sample sessions, then every user's first training session in the inspection, 25 Sep):
# header client_timestamp,x,y,button,state,window; states Move / Drag / Pressed / Released only and buttons
# None / Left / Right, SapiMouse's vocabulary (NoButton for None). Movement events arrive every 8-15 ms
# (median per user), SapiMouse's every 17 ms, one 60-Hz frame: hence the frame coalescing below (16-18 ms
# after it).


# ------------------------------------------------------------------ parsing ---
def _col(header, *names):
    h = [c.strip().lower().replace("_", " ") for c in header]
    for n in names:
        for i, c in enumerate(h):
            if c == n:
                return i
    for n in names:
        for i, c in enumerate(h):
            if n in c:
                return i
    raise KeyError(f"no column like {names} in {header}")


def _columns(header):
    return {"t": _col(header, "timestamp", "client timestamp", "time"), "x": _col(header, "x"),
            "y": _col(header, "y"), "button": _col(header, "button"), "state": _col(header, "state")}


def read_labels(root):
    """{session file name: label}. The file has no header: its first line is a data row."""
    out, dup = {}, 0
    with open(os.path.join(root, "labels.csv"), newline="", encoding="utf-8", errors="ignore") as f:
        for row in csv.reader(f):
            if len(row) >= 3 and row[1].strip():
                name = row[1].strip()
                dup += name in out
                out[name] = int(float(row[2]))
    if dup:
        raise SystemExit(f"labels.csv names {dup} session files twice; the layout needs an amendment")
    return out


def read_events(path):
    """One session file -> [(t_ms, button, state, x, y)] in file order."""
    with open(path, "r", encoding="utf-8", errors="ignore", newline="") as f:
        r = csv.reader(f)
        header = next(r, None)
        if not header:
            return []
        c = _columns(header)
        out = []
        for row in r:
            try:
                t = float(row[c["t"]]) * 1000.0
                x, y = float(row[c["x"]]), float(row[c["y"]])
            except (ValueError, IndexError):
                continue
            b = row[c["button"]].strip() if c["button"] < len(row) else ""
            s = row[c["state"]].strip() if c["state"] < len(row) else ""
            out.append((t, "NoButton" if b.lower() in ("", "none", "nobutton") else b,
                        STATE.get(s.lower(), "Move"), x, y))
    return out


def first_time(path):
    """Timestamp (s) of the first parseable row, or None."""
    with open(path, "r", encoding="utf-8", errors="ignore", newline="") as f:
        r = csv.reader(f)
        header = next(r, None)
        if not header:
            return None
        it = _columns(header)["t"]
        for row in r:
            try:
                return float(row[it])
            except (ValueError, IndexError):
                continue
    return None


def coalesce(events, frame_ms=FRAME_MS):
    """Browser emulation: keep the last movement event of each frame; clicks always kept, in order."""
    out, pending, frame = [], None, None
    for e in events:
        if e[2] in (PRESS, RELEASE):
            if pending is not None:
                out.append(pending)
                pending = None
            out.append(e)
            continue
        f = int(e[0] // frame_ms)
        if pending is not None and f != frame:
            out.append(pending)
        pending, frame = e, f
    if pending is not None:
        out.append(pending)
    return out


def session(path):
    """(A5 windows, steps R, window starts) of one session file."""
    from repr_arch_study import raw_steps, windows, window_starts
    R = raw_steps(coalesce(read_events(path)))
    return windows(R, 1.0, "A5"), R, window_starts(R)


def file_sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def user_dirs(root):
    return sorted(glob.glob(os.path.join(root, "users", "user*")), key=lambda p: int(os.path.basename(p)[4:]))


def files_of(udir, sub):
    return sorted(glob.glob(os.path.join(udir, sub, "*.csv")))


# ------------------------------------------------------------------ selection (Amendment L-1) ---
def enrolment(udir):
    """The first 440 windows of the training sessions in time order, and the time (ms) of the last
    step of the 440th window. Returns (windows, end_ms, sessions used)."""
    tr = sorted(files_of(udir, TRAIN), key=lambda p: (first_time(p) or float("inf"), os.path.basename(p)))
    got, used, end = [], [], None
    for p in tr:
        W, R, st = session(p)
        need = LC.BUDGET - sum(len(w) for w in got)
        if len(W):
            got.append(W[:need])
            used.append(os.path.basename(p))
            if len(W) >= need:
                end = float(R[st[need - 1] + 49, 0])
                break
    E = np.concatenate(got) if got else np.zeros((0, 50, 2), np.float32)
    return E, end, used


def _sample(names, k, seed):
    """Inspection only: k of the names, seeded."""
    if len(names) <= k:
        return list(names)
    idx = np.sort(np.random.default_rng(seed).choice(len(names), k, replace=False))
    return [names[i] for i in idx]


def _pick(cands, k, seed, key, taken=()):
    """Up to k DISTINCT sessions (Amendment L-1 section 4): the candidates are visited in a seeded random
    order and a file whose session key (its first timestamp) is already taken is skipped as a copy of that
    session. Every user's genuine sessions are stored twice, once per test folder, under different names."""
    seen, out = set(taken), []
    for i in np.random.default_rng(seed).permutation(len(cands)):
        kk = key(cands[i])
        if kk is None or kk in seen:
            continue
        seen.add(kk)
        out.append(cands[i])
        if len(out) == k:
            break
    return out


def target_index(root, udir, labels):
    """Which files make up one target (no window of a test file is built here)."""
    u = os.path.basename(udir)
    num = int(u[4:])
    E, end_ms, used = enrolment(udir)
    tests = sorted(files_of(udir, INTERNAL) + files_of(udir, EXTERNAL), key=os.path.basename)
    lab = {p: labels.get(os.path.basename(p)) for p in tests}
    unlabelled = [os.path.basename(p) for p, v in lab.items() if v is None]
    t0 = {p: first_time(p) for p, v in lab.items() if v == 0}
    own_keys = {t for t in t0.values() if t is not None}          # every session of the target, any date
    gen_all = sorted((p for p, t in t0.items() if t is not None and end_ms is not None and t * 1000.0 > end_ms),
                     key=lambda p: (t0[p], os.path.basename(p)))
    genuine = _pick(gen_all, MAX_GENUINE_SESSIONS, [SAMPLE_SEED, num, 0], t0.get)
    genuine.sort(key=lambda p: (t0[p], os.path.basename(p)))
    imp_all = [p for p, v in lab.items() if v == 1]
    impostor = _pick(imp_all, MAX_IMPOSTOR_SESSIONS, [SAMPLE_SEED, num, 1], first_time, taken=own_keys)
    impostor.sort(key=os.path.basename)
    return {"user": u, "enrol": E, "enrolEndMs": end_ms, "enrolSessions": used,
            "genuine": genuine, "impostor": impostor,
            "counts": {"label0Files": len(t0), "label0Sessions": len(own_keys), "label1Files": len(imp_all),
                       "genuineFilesAfterEnrolment": len(gen_all),
                       "genuineSessionsAfterEnrolment": len({t0[p] for p in gen_all}),
                       "genuinePicked": len(genuine), "impostorPicked": len(impostor),
                       "unlabelled": len(unlabelled)}}


def build(ix):
    """Windows of one target: genuine sessions in time order, impostor sessions cut at 150 windows;
    byte-identical files are kept once (a safety net behind _pick's first-timestamp rule)."""
    seen, genuine, impostor, names = set(), [], {}, {"genuine": [], "impostor": []}
    for p in ix["genuine"]:
        h = file_sha(p)
        if h in seen:
            continue
        seen.add(h)
        W = session(p)[0]
        if len(W):
            genuine.append(W)
            names["genuine"].append(os.path.basename(p))
    for p in ix["impostor"]:
        h = file_sha(p)
        if h in seen:
            continue
        seen.add(h)
        W = session(p)[0][:IMP_RUN]
        if len(W):
            impostor[os.path.basename(p)] = W
            names["impostor"].append(os.path.basename(p))
    return {"enrol": ix["enrol"], "test": genuine, "impostor": impostor, "files": names}


def eligible(d):
    """Section 5, with decisions inside one session: 440 enrolment windows, at least one genuine and
    one impostor session holding a full 33-window decision."""
    if len(d["enrol"]) < LC.BUDGET:
        return f"{len(d['enrol'])} enrolment windows"
    if not any(len(s) >= LC.N_DEC for s in d["test"]):
        return "no genuine session with 33 windows"
    if not any(len(s) >= LC.N_DEC for s in d["impostor"].values()):
        return "no impostor session with 33 windows"
    return None


def load(root=ROOT_B, confirmed=False):
    """{"targets": [user...], "get": user -> {"enrol", "test", "impostor"}, "excluded", "manifest"}.
    Eligibility is decided from window counts only (section 5)."""
    if not (LAYOUT_CONFIRMED or confirmed):
        raise SystemExit("bogazici_l.load() is disabled until Amendment L-1 is frozen")
    labels = read_labels(root)
    index, excluded, manifest = {}, {}, {}
    for udir in user_dirs(root):
        ix = target_index(root, udir, labels)
        d = build(ix)
        why = eligible(d)
        manifest[ix["user"]] = {"enrolSessions": ix["enrolSessions"], "enrolEndMs": ix["enrolEndMs"],
                                "counts": ix["counts"], "genuineFiles": d["files"]["genuine"],
                                "impostorFiles": d["files"]["impostor"],
                                "genuineWindows": int(sum(len(s) for s in d["test"])),
                                "impostorWindows": int(sum(len(s) for s in d["impostor"].values()))}
        if why:
            excluded[ix["user"]] = why
        else:
            index[ix["user"]] = ix
        del d
    targets = sorted(index, key=lambda u: int(u[4:]))
    return {"targets": targets, "get": lambda u: build(index[u]), "excluded": excluded, "manifest": manifest}


# ------------------------------------------------------------------ inspection (no model, no score) ---
def inspect(root=ROOT_B, per_folder=10):
    labels = read_labels(root)
    rep = {"root": root, "labels": {"rows": len(labels), "counts": dict(collections.Counter(labels.values()))},
           "users": {}, "vocab": {}}
    all_names, test_names, n_files = collections.Counter(), set(), 0
    vocab = {"state": collections.Counter(), "button": collections.Counter()}
    dts_raw, dts_co = [], []
    for udir in user_dirs(root):
        u = os.path.basename(udir)
        num = int(u[4:])
        row = {}
        for sub in (TRAIN, INTERNAL, EXTERNAL):
            fs = files_of(udir, sub)
            n_files += len(fs)
            all_names.update(os.path.basename(p) for p in fs)
            if sub != TRAIN:
                test_names.update(os.path.basename(p) for p in fs)
            lab = collections.Counter(labels.get(os.path.basename(p), "missing") for p in fs)
            row[sub] = {"files": len(fs), "labels": {str(k): v for k, v in lab.items()}}
            if fs and sub != TRAIN:
                sample = _sample(fs, per_folder, [SAMPLE_SEED, num, 9])
                row[sub]["windowsPerSessionSample"] = [int(len(session(p)[0])) for p in sample]
        tr = sorted(files_of(udir, TRAIN), key=lambda p: (first_time(p) or float("inf"), os.path.basename(p)))
        row["trainingFirstTimes"] = [first_time(p) for p in tr]
        if tr:
            ev = read_events(tr[0])
            for e in ev[:20000]:
                vocab["state"][e[2]] += 1
                vocab["button"][e[1]] += 1
            mv = np.array([e[0] for e in ev if e[2] not in (PRESS, RELEASE)])
            co = coalesce(ev)
            mvc = np.array([e[0] for e in co if e[2] not in (PRESS, RELEASE)])
            from repr_arch_study import raw_steps
            R = raw_steps(co)
            d_raw = np.diff(mv) if len(mv) > 1 else np.zeros(0)
            d_co = np.diff(mvc) if len(mvc) > 1 else np.zeros(0)
            dts_raw.append(float(np.median(d_raw[d_raw > 0])) if (d_raw > 0).any() else None)
            dts_co.append(float(np.median(d_co[d_co > 0])) if (d_co > 0).any() else None)
            row["firstTrainingSession"] = {"file": os.path.basename(tr[0]), "events": len(ev), "afterCoalescing": len(co),
                                           "steps": int(len(R)),
                                           "meanStepSeconds": float(R[:, 5].mean()) if len(R) else None,
                                           "medianMoveIntervalMsRaw": dts_raw[-1], "medianMoveIntervalMsCoalesced": dts_co[-1]}
        E, end_ms, used = enrolment(udir)
        row["enrolment"] = {"windows": int(len(E)), "endMs": end_ms, "sessionsUsed": used}
        gen0 = [p for p in files_of(udir, INTERNAL) + files_of(udir, EXTERNAL) if labels.get(os.path.basename(p)) == 0]
        firsts = [first_time(p) for p in gen0]
        row["genuineSessions"] = {"label0": len(gen0),
                                  "afterEnrolment": int(sum(1 for t in firsts if t is not None and end_ms and t * 1000 > end_ms)),
                                  "beforeEnrolment": int(sum(1 for t in firsts if t is not None and end_ms and t * 1000 <= end_ms))}
        rep["users"][u] = row
        print(f"[inspect] {u}: {row[INTERNAL]['files']} internal / {row[EXTERNAL]['files']} external test files, "
              f"enrolment {row['enrolment']['windows']} windows, genuine after enrolment {row['genuineSessions']['afterEnrolment']}",
              flush=True)
    rep["vocab"] = {k: dict(v.most_common(20)) for k, v in vocab.items()}
    rep["fileNames"] = {"files": n_files, "unique": len(all_names), "testFiles": len(test_names),
                        "testFilesNotInLabels": int(sum(1 for n in test_names if n not in labels)),
                        "labelsNotInTestFiles": int(sum(1 for n in labels if n not in test_names))}
    rep["eventRate"] = {"medianMoveIntervalMsRaw": dts_raw, "medianMoveIntervalMsCoalesced": dts_co}
    heads = {}
    for udir in user_dirs(root)[:2]:
        for sub in (TRAIN, INTERNAL, EXTERNAL):
            fs = files_of(udir, sub)
            if fs:
                with open(fs[0], "r", encoding="utf-8", errors="ignore") as fh:
                    heads[f"{os.path.basename(udir)}/{sub}/{os.path.basename(fs[0])}"] = [fh.readline().rstrip("\n") for _ in range(4)]
    rep["firstLines"] = heads
    return rep


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--root", default=ROOT_B)
    ap.add_argument("--out", default=os.path.join(LC.OUT, "stageC", "bogazici_inspect.json"))
    a = ap.parse_args()
    if a.inspect:
        rep = inspect(a.root)
        os.makedirs(os.path.dirname(a.out), exist_ok=True)
        LC.write_json(a.out, rep, indent=1)
        print(json.dumps({k: v for k, v in rep.items() if k != "users"}, indent=1))
        print(f"wrote {a.out}")
