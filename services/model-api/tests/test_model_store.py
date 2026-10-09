"""model_store.py on the file store (MODEL_STORE=fs): version names, the fingerprint, pruning, deleting.
Runs without NumPy, TensorFlow or boto3:  python -m unittest discover -s services/model-api/tests
(the object store itself is exercised end to end by docker-compose.split-models.yml)."""
import os
import sys
import tempfile
import time
import unittest

ROOT = tempfile.mkdtemp(prefix="model-store-")
os.environ["ARTIFACTS_DIR"] = ROOT
os.environ["MODEL_STORE"] = "fs"
os.environ["MODEL_KEEP_VERSIONS"] = "2"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import model_store as ms  # noqa: E402


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())


class Versions(unittest.TestCase):
    def test_a_new_version_is_named_after_its_family_and_unique(self):
        base = os.path.join(ROOT, "users", "user-7", "final_model")
        a, b = ms.new_version(base), ms.new_version(base)
        self.assertNotEqual(a, b)
        self.assertTrue(ms.is_version(a))
        self.assertEqual(ms.family(a), base)
        self.assertFalse(ms.is_version(base), "a folder from before versions is not a version")
        self.assertFalse(ms.is_version(a + "_loso"), "a scratch folder beside a version is not one")

    def test_an_action_model_is_stored_as_its_version_folder(self):
        v = ms.new_version(os.path.join(ROOT, "users", "user-7", "mouse_action_model"))
        self.assertEqual(ms.unit(os.path.join(v, "mouse_action_model.joblib")), v)
        legacy = os.path.join(ROOT, "users", "user-7", "mouse_action_model.joblib")
        self.assertEqual(ms.unit(legacy), legacy)


class Fingerprint(unittest.TestCase):
    def test_it_is_the_study_logs_fingerprint(self):
        # The value ca-service's lib/studyLog.js computed for this folder (files in path order, each one's
        # relative path, a NUL byte, its bytes), so model_sha256 keeps its meaning across the change.
        d = os.path.join(ROOT, "fp", "final_model-20261009T120000Z-abc123")
        write(os.path.join(d, "saved_model.pb"), "graph")
        write(os.path.join(d, "variables", "variables.index"), bytes([0, 1, 2, 3, 255]))
        write(os.path.join(d, "keras_metadata.pb"), "meta")
        self.assertEqual(ms.sha256(d), "92e9cc0f4cfc233900e2d45588c9aa8339d1b607cf1e172d103889054b3f5670")
        self.assertIsNone(ms.sha256(os.path.join(ROOT, "fp", "missing")))


class Housekeeping(unittest.TestCase):
    def test_prune_keeps_the_newest_and_the_current_one(self):
        base = os.path.join(ROOT, "users", "user-9", "mouse_model")
        made = []
        for i in range(5):
            v = f"{base}-2026100{i}T120000Z-00000{i}"
            write(os.path.join(v, "f2_head.json"), "{}")
            made.append(v)
        write(os.path.join(base, "f2_head.json"), "{}")            # the folder from before versions
        removed = ms.prune(base, keep=[made[0]])                    # made[0] is the caller's current one
        self.assertEqual(sorted(removed), sorted(made[1:3]))
        self.assertTrue(all(os.path.isdir(p) for p in (made[0], made[3], made[4], base)))
        self.assertEqual(ms.versions(base), [made[0], made[3], made[4]])

    def test_only_versions_are_ever_deleted(self):
        legacy = os.path.join(ROOT, "users", "user-10", "final_model")
        write(os.path.join(legacy, "saved_model.pb"), "x")
        with self.assertRaises(ValueError):
            ms.delete(legacy)
        self.assertTrue(os.path.isdir(legacy))

    def test_on_the_file_store_a_missing_model_is_reported_missing(self):
        here = os.path.join(ROOT, "users", "user-11", "final_model")
        write(os.path.join(here, "saved_model.pb"), "x")
        self.assertFalse(ms.ensure_local(os.path.join(ROOT, "users", "user-11", "final_model-20261009T120000Z-abcdef")))
        self.assertTrue(ms.ensure_local(here))
        self.assertEqual(ms.publish(here), ms.sha256(here), "publishing on the file store only fingerprints")


class Feed(unittest.TestCase):
    def test_new_versions_are_announced_in_order_and_old_entries_removed(self):
        feed = os.path.join(ROOT, "users", ".feed")
        os.makedirs(feed, exist_ok=True)
        write(os.path.join(feed, "20200101T000000Z-00000000"), "users/user-1/final_model")   # long expired
        v1 = ms.new_version(os.path.join(ROOT, "users", "user-12", "final_model"))
        v2 = ms.new_version(os.path.join(ROOT, "users", "user-12", "mouse_model"))
        ms.announce(v1)
        time.sleep(1.1)
        ms.announce(v2)
        got = ms.feed_after("", since_s=60)
        self.assertEqual([os.path.realpath(p) for _, p in got], [os.path.realpath(v1), os.path.realpath(v2)])
        self.assertEqual([p for _, p in ms.feed_after(got[0][0])], [got[1][1]], "only what came after the cursor")
        self.assertNotIn("20200101T000000Z-00000000", os.listdir(feed), "expired entries are removed")


if __name__ == "__main__":
    unittest.main()
