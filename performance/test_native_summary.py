"""Regression for resource accounting and compressed raw-artifact reproduction."""
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("native_summary", Path(__file__).with_name("native-summary.py"))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class ResourceSummaryTests(unittest.TestCase):
    def test_exit_is_not_cache_release_and_cpu_retains_final_lifetime_ticks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "metadata.json").write_text(json.dumps({"clockTicks": 100}))
            report = {"startup": {"launchToTimeOrigin": 100, "ready": 100}, "resources": [{"name": "afterRelease", "at": 200}], "frames": [], "spans": [], "ipc": [], "observations": {"longNavigations": 0, "savedOpenOnly": [1, 2, 3, 40, 20]}}
            resources = [
                {"elapsed": 0.1, "rssKiB": 1024, "processes": [{"pid": 1, "name": "app", "cpuTicks": 10}]},
                {"elapsed": 0.3, "rssKiB": 0, "processes": [{"pid": 1, "name": "app", "cpuTicks": 30}]},
            ]
            for compressed in [False, True]:
                for name, value in [("run-0.json", report), ("resources-0.json", resources)]:
                    encoded = json.dumps(value).encode()
                    (root / (name + (".gz" if compressed else ""))).write_bytes(gzip.compress(encoded) if compressed else encoded)
                result = summary.summarize(root)
                self.assertEqual(result["runs"][0]["checkpoints"][0]["rssMiB"], 1)
                self.assertEqual(result["runs"][0]["cpuSeconds"], 0.3)
                self.assertEqual(result["observations"]["savedOpenOnly"], {"n": 2, "median": 30, "p95": 40, "max": 40})
                for file in root.glob("*0.json*"):
                    file.unlink()


if __name__ == "__main__":
    unittest.main()
