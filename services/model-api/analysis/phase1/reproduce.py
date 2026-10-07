"""Step 1 of Phase 1: reproduce the published P0 (development), P6 (lockbox 1) and K3 (lockbox 2)
numbers from the stored per-user score streams, with verbatim copies of the original functions.
Nothing new is computed here; a mismatch stops everything downstream."""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p1lib as L  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
STUDY = os.path.join(ROOT, "artifacts", "repr_arch_study")
S0 = {"name": "S0", "method": "A", "q": 1, "rule": "vote", "n": 60, "k": 30}
S1 = {"name": "S1", "method": "B", "q": 20, "rule": "vote", "n": 60, "k": 33}
S2 = {"name": "S2", "method": "B", "q": 20, "rule": "vote", "n": 40, "k": 29}


def win_metrics(g, imp):
    return {"auc": L.auc_of(g, imp), "eer": L.eer_of(g, imp)[0], "tar01": L.tar_at_far(g, imp, 0.01)[0]}


def p0():
    P = json.load(open(os.path.join(STUDY, "parts", "J_P0_S0.json")))
    per, full = {}, {}
    for u in P["perUser"]:
        cal, tst = L.halves(u)
        tau = float(np.percentile(u["_enrolScores"], S0["q"]))
        imp = np.concatenate(list(tst["runs"].values()))
        per[u["participant"]] = {"threshold": tau, **win_metrics(tst["g"], imp)}
        full[u["participant"]] = L.per_user(tst, tau, "vote", 60, 30)
    live = L.summary(full)
    win = {m: float(np.mean([v[m] for v in per.values()])) for m in ("auc", "eer", "tar01")}
    win["aucMedian"] = float(np.median([v["auc"] for v in per.values()]))
    return {"perWindow": win, "live": live, "n": len(per)}


def lockbox(folder, systems):
    recs = [json.load(open(os.path.join(STUDY, "parts", folder, f)))
            for f in sorted(os.listdir(os.path.join(STUDY, "parts", folder))) if f.endswith(".json")]
    out = {}
    for S in systems:
        per = {}
        for r in recs:
            d = r["systems"][S["name"]]
            src = np.asarray(d["enrol"] if S["method"] == "A" else d["oof"], float)
            tau = float(np.percentile(src, S["q"]))
            h = {"g": np.asarray(d["genuine"], float), "runs": {k: np.asarray(v, float) for k, v in d["impostor"].items()}}
            x = L.per_user(h, tau, S["rule"], S["n"], S["k"])
            imp = np.concatenate(list(h["runs"].values()))
            per[r["participant"]] = {"promptsPerMin": x["promptsPerMin"], "prompts": x["prompts"],
                                     "runsCaught": float(np.mean(x["caught"])), **win_metrics(h["g"], imp)}
        users = sorted(per)
        out[S["name"]] = {k: float(np.nanmean([per[u][k] for u in users])) for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01")}
        out[S["name"]]["usersNeverPrompted"] = int(sum(per[u]["prompts"] == 0 for u in users))
        out[S["name"]]["_per"] = per
    a, b = systems[0]["name"], systems[1]["name"]
    users = sorted(out[a]["_per"])
    tests = {k: L.boot([out[a]["_per"][u][k] for u in users], [out[b]["_per"][u][k] for u in users])
             for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01")}
    return out, tests


def check(label, got, want, tol=1e-9):
    ok = abs(got - want) <= tol
    print(f"  {'OK ' if ok else 'BAD'} {label:32s} got {got:.6f} published {want:.6f}")
    return ok


if __name__ == "__main__":
    allok = True
    pub0 = json.load(open(os.path.join(STUDY, "analysis_J_P0.json")))
    r0 = p0()
    print(f"P0 development S0 ({r0['n']} targets)")
    for m in ("auc", "eer", "tar01"):
        allok &= check(f"window {m} mean", r0["perWindow"][m], pub0["perWindow"][m]["mean"])
    for m in ("promptsPerMinMean", "impostorRunsCaught", "usersNeverPrompted", "timeToCatchMedianS"):
        allok &= check(f"live {m}", r0["live"][m], pub0["liveCadence"][m])

    for folder, systems, pubf in (("J_P6", [S0, S1], "analysis_J_P6.json"), ("K3", [S0, S2], "analysis_K3.json")):
        pub = json.load(open(os.path.join(STUDY, pubf)))
        out, tests = lockbox(folder, systems)
        print(f"{folder} lockbox")
        for S in systems:
            for m in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01"):
                allok &= check(f"{S['name']} {m}", out[S["name"]][m], pub["summary"][S["name"]][m])
        for m in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01"):
            allok &= check(f"diff {m} meanDiff", tests[m]["meanDiff"], pub["tests"][m]["meanDiff"])
            allok &= check(f"diff {m} ci lo", tests[m]["ci95"][0], pub["tests"][m]["ci95"][0])
    print("ALL MATCH" if allok else "MISMATCH")
