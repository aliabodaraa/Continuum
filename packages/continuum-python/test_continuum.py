"""continuum.py: only verdicts pass verify_token, events have verify_event, and require_verified waits on a warm-up
(2026-11-08). Throwaway fixtures (test_fixtures.json, made with Node's crypto) stand in for the gateway's JWKS.
    python -m unittest packages/continuum-python/test_continuum.py
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import continuum  # noqa: E402

FIX = json.load(open(os.path.join(HERE, "test_fixtures.json"), encoding="utf-8"))
T = FIX["tokens"]


class Verdicts(unittest.TestCase):
    def setUp(self):
        self._fetch = continuum._fetch_jwks
        continuum._fetch_jwks = lambda uri: FIX["jwks"]

    def tearDown(self):
        continuum._fetch_jwks = self._fetch

    def refused(self, token, reason, fn=None):
        with self.assertRaises(ValueError) as cm:
            (fn or continuum.verify_token)(token, "jwks")
        self.assertEqual(str(cm.exception), reason)

    def test_only_a_verdict_passes(self):
        self.assertEqual(continuum.verify_token(T["genuine"], "jwks")["risk"], "genuine")
        self.refused(T["identity"], "not_a_verdict")
        self.refused(T["event"], "not_a_verdict")
        self.refused(T["noExpiry"], "no_expiry")
        self.refused(T["expired"], "expired")

    def test_events_have_their_own_check(self):
        self.assertEqual(continuum.verify_event(T["event"], "jwks", max_age_sec=0)["event"], "risk-change")
        self.refused(T["event"], "stale", lambda t, u: continuum.verify_event(t, u))
        self.refused(T["genuine"], "not_an_event", lambda t, u: continuum.verify_event(t, u, max_age_sec=0))

    def test_require_verified_waits_on_a_warmup(self):
        self.assertEqual(continuum.require_trusted(T["warmup"], "jwks")[0], True)
        self.assertEqual(continuum.require_verified(T["warmup"], "jwks"), (False, "verdict_pending"))
        self.assertEqual(continuum.require_verified(T["genuine"], "jwks")[0], True)
        self.assertEqual(continuum.require_verified(T["suspicious"], "jwks"), (False, "step_up_required"))


if __name__ == "__main__":
    unittest.main()
