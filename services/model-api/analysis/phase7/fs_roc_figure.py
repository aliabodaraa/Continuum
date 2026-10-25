"""Thesis figure {F:roc_sapi} redrawn for the adopted mouse channel (owner, 2026-10-22: adopt SapiMouse's training
settings). Pooled ROC of the N-window decisions (pct score, analyze_l.roc_points) on the 19 development users of
protocol L stage D, for the frozen network with the logistic head: the network trained with SapiMouse's settings
(experiment FS, the adopted channel) and the same channel with the earlier settings (stage D's F2). The circles are each
channel's deployed rule (20th percentile, 33 of 60) from analyze_l.deployed_point. Colours and line widths darkened on
2026-10-25 so the figure stays readable on a projector (owner).

    python services/model-api/analysis/phase7/fs_roc_figure.py   # paper/figures/fig_mouse_sapimouse_roc_sm.png
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
import l_common as LC  # noqa: E402
import analyze_l as A  # noqa: E402

E = A.E
OUT = sys.argv[1] if len(sys.argv) > 1 else "/app/paper_figures/fig_mouse_sapimouse_roc_sm.png"


def main():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    folder, path, d, hashes, V, code = A.load(False, None)
    targets = list(d["targets"])
    fs = LC.units_from_json(json.load(open("/app/artifacts/phase7/fs/scores_FS.json"))["units"])
    for u in fs.values():
        u["tau"] = float(np.percentile(u["ref"], LC.Q_TAU))
    Vc = {"FS": {"fs": fs}, "F2": V["F2"]}
    label = {"FS": "Network trained as in SapiMouse (adopted)", "F2": "Earlier training settings"}
    style = {"FS": dict(color="#0b4f9c", lw=2.6, ls="-"), "F2": dict(color="#4d4d4d", lw=2.0, ls="--")}
    pts = A.deployed_point(Vc, targets)
    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    for ax, n in zip(axes, (34, 60)):     # Table 6's three-block and five-block rows
        _val, _pv, decs = A.per_user_auc(Vc, targets, n)
        for s in ("FS", "F2"):
            far, tar, auc = A.roc_points(decs[s], targets)
            ax.plot(far, tar, label=f"{label[s]}  AUC {auc:.3f}", **style[s])
        if n == 60:
            for s in ("FS", "F2"):
                p = pts[s]
                ax.plot(p["far"], 1 - p["frr"], "o", color=style[s]["color"], ms=9, mfc="white", mew=2.6)
            ax.plot([], [], "o", color="k", mfc="white", mew=2.6, label="deployed rule: 20th pct, 33 of 60")
        ax.plot([0, 1], [0, 1], color="#6e6e6e", lw=1.2)
        for sp in ax.spines.values():
            sp.set_linewidth(1.1)
        ax.set_xlabel("false accept rate (impostor decisions accepted)")
        ax.set_ylabel("true accept rate (genuine decisions accepted)")
        ax.set_title(f"{round(E.seconds(n)):g}-s decisions (N = {n}), 19 users")
        ax.legend(loc="lower right", fontsize=8)
        ax.set_xlim(-0.01, 1.01); ax.set_ylim(-0.01, 1.01)
    fig.tight_layout()
    fig.savefig(OUT, dpi=150)
    plt.close(fig)
    print("wrote", OUT, "| deployed points:", {s: {k: round(v, 3) for k, v in pts[s].items()} for s in pts})


if __name__ == "__main__":
    main()
