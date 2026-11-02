"""Isolated Tauri/WebKitGTK release runner; Pillow is used only for deterministic fixtures.

Usage: python performance/native-run.py /tmp/rf-native-after --count 1000 --runs 3
No user data or network service is used. Build first with native-build.mjs.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import random
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image


def operation(value):
    return list(value.to_bytes(16, "little"))


def base36(value):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = digits[remainder] + result
    return result or "0"


def images():
    rng = random.Random(20261030)
    small = Image.frombytes("RGB", (384, 256), rng.randbytes(384 * 256 * 3))
    output = io.BytesIO()
    small.save(output, "JPEG", quality=35)
    thumbnail = output.getvalue()
    large = small.resize((1920, 1080))
    output = io.BytesIO()
    large.save(output, "JPEG", quality=85)
    return thumbnail, output.getvalue()


def profile(path, count, thumbnail, unique=False):
    data = path / "data/dev.randomframe.desktop"
    cache = path / "cache/dev.randomframe.desktop/thumbnails"
    data.mkdir(parents=True)
    cache.mkdir(parents=True)
    history, history_ops, favorites, memberships = [], [], [], []
    stamp = 1760000000000
    for i in range(count):
        item_id = base36(100000 + i)
        common = {"source": "prntsc", "id": item_id, "source_page_url": f"https://prnt.sc/{item_id}"}
        history.append({"source": "prntsc", "id": item_id, "sourcePageUrl": common["source_page_url"], "viewedAt": stamp + i})
        history_ops.append({**common, "operation_id": operation(i + 1), "order_at": stamp + i, "viewed_at": stamp + i, "day": "2025-10-09", "day_inferred": True})
        favorites.append({**common, "operation_id": operation(i + 1), "added_at": stamp + i})
        if i % 5:
            memberships.append({"operation_id": operation(200000 + i), "favorite_operation_id": operation(i + 1), "collection_id": operation(100000 + i % 10)})
        # Valid JPEG trailing bytes make each data URL distinct without changing decoded pixels.
        (cache / f"prntsc-{item_id}.jpg").write_bytes(thumbnail + i.to_bytes(4, "little") if unique else thumbnail)
    collections = [{"collection_id": operation(100000 + i), "name": {"clock": 1, "operation_id": operation(100000 + i), "value": f"Collection {i}"}} for i in range(10)]
    # First collection must have members; i % 5 excludes collections 0 and 5.
    collections = collections[1:] + collections[:1]
    (data / "favorites-v4.json").write_text(json.dumps({"version": 4, "favorites": favorites, "removed": [], "collections": collections, "memberships": memberships}))
    (data / "history-v3.json").write_text(json.dumps({"version": 3, "history": history, "index": count - 1, "history_ops": history_ops, "removed_history_ops": [], "local_views": {f"prntsc\0{item['id']}": item["viewedAt"] for item in history}}))
    assert len(history) == count and len(favorites) == count
    assert len(list(cache.iterdir())) == count


def pss(entry):
    # Proportional set size apportions shared pages; RSS counts them once per process.
    try:
        for line in (entry / "smaps_rollup").read_text().splitlines():
            if line.startswith("Pss:"):
                return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return 0


def disk_fingerprint(cache):
    digest = hashlib.sha256()
    names = sorted(cache.glob("*.jpg"))
    for file in names:
        digest.update(file.name.encode() + file.read_bytes())
    return {"files": len(names), "sha256": digest.hexdigest(), "tmp": len(list(cache.glob("*.tmp")))}


def processes(root):
    all_stats = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            text = (entry / "stat").read_text()
            fields = text.rsplit(")", 1)[1].split()
            all_stats[int(entry.name)] = {"pid": int(entry.name), "name": text.split("(", 1)[1].rsplit(")", 1)[0], "ppid": int(fields[1]), "cpuTicks": int(fields[11]) + int(fields[12]), "rssKiB": int(fields[21]) * os.sysconf("SC_PAGE_SIZE") // 1024, "pssKiB": pss(entry)}
        except (OSError, ValueError, IndexError):
            continue
    selected = {root}
    while True:
        more = {pid for pid, stat in all_stats.items() if stat["ppid"] in selected}
        if more <= selected:
            break
        selected |= more
    return [all_stats[pid] for pid in selected if pid in all_stats]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("build", type=Path)
    parser.add_argument("--count", type=int, choices=[100, 1000, 5000, 10000], default=100)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--long-ms", type=int, default=0)
    parser.add_argument("--unique-thumbnails", action="store_true")
    parser.add_argument("--mode", choices=["", "retention"], default="")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    thumbnail, large = images()
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append({"at": time.time(), "path": self.path})
            if self.path.startswith("/page/"):
                body = b'<img id="screenshot-image" src="https://image.prntscr.com/fixture.jpg">'
                mime = "text/html"
            elif self.path.startswith("/asset/"):
                body, mime = large, "image/jpeg"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    run_profile = args.output.resolve() / "profile"
    if not str(run_profile).startswith("/tmp/"):
        raise ValueError("Raw runs/profiles must be under /tmp; copy result JSON to the repository afterward")
    profile(run_profile, args.count, thumbnail, args.unique_thumbnails)
    metadata = {"count": args.count, "thumbnailBytes": len(thumbnail), "distinctThumbnailURLs": args.unique_thumbnails, "thumbnailSHA256": hashlib.sha256(thumbnail).hexdigest(), "imageBytes": len(large), "imageSHA256": hashlib.sha256(large).hexdigest(), "dimensions": [1920, 1080], "clockTicks": os.sysconf("SC_CLK_TCK"), "build": json.loads((args.build / "build-info.json").read_text()), "display": os.environ.get("DISPLAY"), "cacheState": "First launch: fresh synthetic profile, OS page cache uncontrolled. Subsequent launches reuse profile and OS caches; not disk-cold."}
    (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2))
    cache_dir = run_profile / "cache/dev.randomframe.desktop/thumbnails"
    fingerprints = {"before": disk_fingerprint(cache_dir)}
    for run in range(args.runs):
        result = args.output.resolve() / f"run-{run}.json"
        env = {**os.environ, "XDG_DATA_HOME": str(run_profile / "data"), "XDG_CACHE_HOME": str(run_profile / "cache"), "XDG_CONFIG_HOME": str(run_profile / "config"), "RF_RESULT": str(result), "RF_LAUNCH_MS": str(time.time_ns() // 1000000), "RF_LONG_MS": str(args.long_ms), "RF_SAMPLES": str(args.samples), "RF_MODE": args.mode, "RF_FIXTURE_URL": f"http://127.0.0.1:{server.server_port}"}
        # Use real Wayland/GPU settings from this desktop; do not disable compositing or animations.
        started = time.monotonic()
        with (args.output / f"run-{run}.log").open("w") as log:
            process = subprocess.Popen([str(args.build.resolve() / "random-frame")], env=env, stdout=log, stderr=log, start_new_session=True)
            resources = []
            deadline = started + 240 + args.long_ms / 1000 + (3000 if args.mode else 0)
            next_progress = 45
            try:
                while process.poll() is None:
                    stats = processes(process.pid)
                    resources.append({"elapsed": time.monotonic() - started, "epochMs": time.time() * 1000, "processes": stats, "rssKiB": sum(stat["rssKiB"] for stat in stats), "pssKiB": sum(stat["pssKiB"] for stat in stats)})
                    if (args.long_ms or args.mode) and resources[-1]["elapsed"] >= next_progress:
                        print(json.dumps({"elapsedSeconds": round(resources[-1]["elapsed"]), "rssMiB": round(resources[-1]["rssKiB"] / 1024)}), flush=True)
                        next_progress += 30
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"Native app timed out; see {log.name}")
                    time.sleep(0.25)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=10)
                (args.output / f"resources-{run}.json").write_text(json.dumps(resources))
        if not result.exists():
            raise RuntimeError(f"App exited {process.returncode} without result; see {log.name}")
        fingerprints[f"after-run-{run}"] = disk_fingerprint(cache_dir)
        (args.output / "disk-fingerprints.json").write_text(json.dumps(fingerprints, indent=2))
        report = json.loads(result.read_text())
        if "error" in report:
            raise RuntimeError(f"Native workload failed: {report['error']}; see {result}")
        trace = []
        for category, spans in [("function-wall", report["spans"]), ("ipc-wall", report["ipc"])]:
            for span in spans:
                trace.append({"name": span["name"], "cat": category, "ph": "X", "ts": span["start"] * 1000, "dur": span["duration"] * 1000, "pid": 1, "tid": category, "args": {"phase": span["phase"]}})
        for frame in report["frames"]:
            trace.append({"name": "rAF gap (not presented FPS)", "ph": "C", "ts": frame["at"] * 1000, "pid": 1, "tid": "frames", "args": {"ms": frame["gap"]}})
        for sample in resources:
            if not sample["processes"] or not sample["rssKiB"]:
                continue
            trace.append({"name": "Process-tree RSS (shared pages counted per process)", "ph": "C", "ts": (sample["elapsed"] * 1000 - report["startup"]["launchToTimeOrigin"]) * 1000, "pid": 1, "tid": "resources", "args": {"MiB": sample["rssKiB"] / 1024}})
        (args.output / f"trace-{run}.json").write_text(json.dumps({"traceEvents": trace}))
        print(json.dumps({"run": run, "startup": report["startup"], "peakRssMiB": max(sample["rssKiB"] for sample in resources) / 1024, "navigations": report["observations"].get("longNavigations", 0)}), flush=True)
    (args.output / "fixture-requests.json").write_text(json.dumps(requests))
    server.shutdown()


if __name__ == "__main__":
    main()
