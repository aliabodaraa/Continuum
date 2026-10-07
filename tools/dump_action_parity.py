"""Dump raw SapiMouse events plus the TRAINING-side action features, so the
browser extractor can be checked against them.

    python tools/dump_action_parity.py > /tmp/parity.json
    node  tools/action_parity_check.js /tmp/parity.json
"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "services", "model-api"))

from preprocess_mouse_actions import (  # noqa: E402
    read_events, segment_actions, action_features,
)

DATA = os.getenv("SAPIMOUSE_DIR", "/app/data/sapimouse")
N_FILES = int(os.getenv("PARITY_FILES", "6"))


def main():
    files = []
    for ud in sorted(glob.glob(os.path.join(DATA, "user*")))[:N_FILES]:
        files.extend(sorted(glob.glob(os.path.join(ud, "*.csv")))[:1])

    samples = []
    for path in files:
        events = read_events(path)
        # The browser hands over milliseconds and a state string; hand the JS
        # side exactly that, so the comparison covers the unit conversion too.
        js_events = [{"t": t * 1000.0, "x": x, "y": y, "state": state}
                     for (t, _button, state, x, y) in events]
        actions = [{"type": int(a), "features": [float(v) for v in action_features(a, evs)]}
                   for a, evs in segment_actions(events)]
        samples.append({
            "name": os.path.relpath(path, DATA),
            "events": js_events,
            "actions": actions,
        })

    json.dump({"samples": samples}, sys.stdout)


if __name__ == "__main__":
    main()
