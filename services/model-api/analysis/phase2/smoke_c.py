"""SMOKE TEST ONLY for stage C: stand-in "Bogazici" data built from SapiMouse base-val users.

Two base-val users are targets (enrolment = the first 440 windows of the 3-min session, genuine = the
1-min session cut into two sessions); the 1-min sessions of four more users, cut in two, are the
impostor sessions (at most 150 windows each). Same interface as bogazici_l.load(). Not a result.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402


def synthetic_data():
    _, l = LC.splits()
    users = l["baseVal"][:6]
    W = LC.Windows("stage C smoke")
    halves = {}
    for u in users:
        sh = W.get(u, "short")
        halves[u] = [sh[:len(sh) // 2], sh[len(sh) // 2:]]
    imp = {f"{u}:s{j}": s[:150] for u in users[2:] for j, s in enumerate(halves[u])}
    data = {u: {"enrol": W.get(u, "long")[:LC.BUDGET], "test": halves[u], "impostor": imp} for u in users[:2]}
    return {"targets": list(data), "get": lambda u: data[u], "excluded": {}, "manifest": {}}
