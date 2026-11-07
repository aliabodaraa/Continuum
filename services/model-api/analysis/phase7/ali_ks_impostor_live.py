"""Same test as ali_ks_impostor_test.py, on windows built by the RUNNING ca-service code (ks_rebuild.js: KeyRecs key
events rebuilt from the digraph timings, then featureWindowsWithKeys from /app/lib/keystrokeSecurity.js). Each
participant-session stream is cut into disjoint 60-window segments (fresh page each), replayed through the live rule."""
import argparse, json, os, sys, time
import numpy as np
sys.path.insert(0, "/app/services/model-api")
sys.path.insert(0, "/work")
import api  # noqa: E402
from ali_ks_impostor_test import first_request, PACKETS, MARKS, KEYS_PER_SECOND, SEG  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    t0 = time.time()
    idx = json.load(open(a.prefix + ".json"))
    W = np.fromfile(a.prefix + ".f32", dtype=np.float32).reshape(-1, 50, 6)
    assert len(W) == idx["total"], (len(W), idx["total"])
    model = api.get_user_model(a.model)
    scores = model.predict(api.scale_windows(api.to_window_array(W), None), batch_size=2048, verbose=0)[:, 1]
    res = {"source": "KeyRecs events rebuilt, windows by the running ca-service code", "windows": int(len(W)),
           "streams": len(idx["index"]), "impostorWindowsAccepted": round(100 * float((scores >= 0.5).mean()), 1),
           "packets": {}}
    for p in PACKETS:
        rows, o = [], 0
        for g in idx["index"]:
            s = scores[o:o + g["windows"]]
            o += g["windows"]
            for start in range(0, len(s) - SEG + 1, SEG):
                n = first_request(s[start:start + SEG], p)
                rows.append({"user": g["participant"], "caughtAtKeys": None if n is None else 51 + 10 * (n - 1)})
        caught = [r["caughtAtKeys"] for r in rows if r["caughtAtKeys"] is not None]
        per_user = {}
        for r in rows:
            per_user.setdefault(r["user"], []).append(r["caughtAtKeys"] is not None)
        res["packets"][str(p)] = {
            "attempts": len(rows), "caught": len(caught), "caughtShare": round(100 * len(caught) / len(rows), 1),
            "caughtByKeys": {str(m): round(100 * sum(1 for c in caught if c <= m) / len(rows), 1) for m in MARKS},
            "medianKeysToCatch": round(float(np.median(caught)), 0) if caught else None,
            "medianSecondsToCatch": round(float(np.median(caught)) / KEYS_PER_SECOND, 1) if caught else None,
            "peopleCaughtInEverySegment": sum(1 for v in per_user.values() if all(v)),
            "peopleNeverCaught": sum(1 for v in per_user.values() if not any(v)), "people": len(per_user)}
    res["seconds"] = round(time.time() - t0, 1)
    json.dump(res, open(os.path.join(a.out, "ali_ks_impostor_live_result.json"), "w"), indent=1)
    print(f"live-built windows {res['windows']} in {res['streams']} streams, impostor windows accepted {res['impostorWindowsAccepted']}%")
    for p, s in res["packets"].items():
        print(f"packet {p:>2}: caught {s['caught']}/{s['attempts']} ({s['caughtShare']}%) | by keys {s['caughtByKeys']} | "
              f"median {s['medianKeysToCatch']} keys (~{s['medianSecondsToCatch']} s) | people always caught "
              f"{s['peopleCaughtInEverySegment']}/{s['people']}, never {s['peopleNeverCaught']}")


if __name__ == "__main__":
    main()
