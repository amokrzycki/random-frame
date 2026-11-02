"""Run the native workload on the isolated rf-performance Android emulator only.

Build the disposable APK first; use --output /tmp/... . This never targets USB devices.
Android results are debug/emulator evidence, separate from the Linux release matrix.
"""

import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, choices=[100, 1000, 10000], default=100)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--installed", action="store_true", help="Use this APK's already installed package")
    args = parser.parse_args()
    if not args.apk.is_file():
        raise ValueError(f"APK does not exist: {args.apk}")
    if not str(args.output.resolve()).startswith("/tmp/"):
        raise ValueError("Synthetic profiles and raw Android runs must stay in /tmp")
    args.output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("native_run", Path(__file__).with_name("native-run.py"))
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    thumbnail, large = native.images()
    native.profile(args.output / "profile", args.count, thumbnail, True)
    adb_path = str(Path.home() / "Android/Sdk/platform-tools/adb")
    serial, package = "emulator-5580", "dev.randomframe.android.debug"

    def adb(*command, raw=False, data=None):
        result = subprocess.run([adb_path, "-s", serial, *command], input=data, capture_output=True, check=True)
        return result.stdout if raw else result.stdout.decode().strip()

    if adb("shell", "getprop", "ro.kernel.qemu") != "1" or adb("emu", "avd", "name").splitlines()[0] != "rf-performance":
        raise ValueError("Only the isolated rf-performance emulator is allowed")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append({"at": time.time(), "path": self.path})
            if self.path.startswith("/page/"):
                body, mime = b'<img id="screenshot-image" src="https://image.prntscr.com/fixture.jpg">', "text/html"
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
    try:
        if not args.installed:
            adb("install", "-r", "-t", str(args.apk.resolve()))
        adb("shell", "am", "force-stop", package)
        # This package belongs exclusively to the newly created synthetic AVD.
        adb("shell", "pm", "clear", package)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as tar:
            data = args.output / "profile/data/dev.randomframe.desktop"
            for file in data.iterdir():
                tar.add(file, arcname=file.name)
            tar.add(args.output / "profile/cache/dev.randomframe.desktop/thumbnails", arcname="cache/thumbnails")
        adb("shell", "run-as", package, "tar", "xf", "-", data=archive.getvalue())
        adb("reverse", "tcp:18787", f"tcp:{server.server_port}")
        metadata = {
            "count": args.count,
            "android": adb("shell", "getprop", "ro.build.version.release"),
            "pageSize": adb("shell", "getconf", "PAGE_SIZE"),
            "webview": adb("shell", "dumpsys", "webviewupdate"),
            "apk": str(args.apk),
            "apkSHA256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
            "buildType": "debug x86_64, SwiftShader emulator; not release or physical hardware",
            "startupClock": "WebView time origin only; ignore Linux launchToTimeOrigin field (config launch=0)",
        }
        (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2))
        for run in range(args.runs):
            system_pid = adb("shell", "pidof", "system_server")
            adb("shell", "am", "force-stop", package)
            adb("shell", "run-as", package, "rm", "-f", "performance-result.json")
            launch = adb("shell", "am", "start", "-W", "-n", f"{package}/dev.randomframe.android.MainActivity")
            (args.output / f"launch-{run}.log").write_text(launch)
            app_pid = adb("shell", "pidof", package)
            deadline = time.monotonic() + 240
            while time.monotonic() < deadline:
                if adb("shell", "pidof", "system_server") != system_pid:
                    raise RuntimeError("Android system_server restarted during the workload; reject these timings")
                try:
                    current_pid = adb("shell", "pidof", package)
                except subprocess.CalledProcessError as error:
                    raise RuntimeError("Android app exited before its workload report; inspect crash/exit logs") from error
                if current_pid != app_pid:
                    raise RuntimeError("Android app process changed during the workload; reject these timings")
                try:
                    report = json.loads(adb("exec-out", "run-as", package, "cat", "performance-result.json"))
                    (args.output / f"run-{run}.json").write_text(json.dumps(report))
                    if "error" in report:
                        raise RuntimeError(report["error"])
                    if report.get("done") is not True or report.get("count") != args.count:
                        raise RuntimeError("Native workload did not finish with the expected fixture count")
                    print(json.dumps({"run": run, "readyFromWebViewOriginMs": report["startup"]["ready"], "done": report["done"]}), flush=True)
                    break
                except (subprocess.CalledProcessError, json.JSONDecodeError):
                    pass
                time.sleep(1)
            else:
                raise TimeoutError("Native Android workload did not finish within 240s")
            (args.output / f"meminfo-{run}.log").write_text(adb("shell", "dumpsys", "meminfo", package))
    except Exception:
        (args.output / "error.log").write_text(traceback.format_exc())
        raise
    finally:
        for name, command in [
            ("crash.log", ("logcat", "-d", "-b", "crash", "-t", "200")),
            ("exit-info.log", ("shell", "dumpsys", "activity", "exit-info", package)),
        ]:
            try:
                (args.output / name).write_text(adb(*command))
            except subprocess.CalledProcessError:
                pass
        (args.output / "fixture-requests.json").write_text(json.dumps(requests))
        for command in [("shell", "am", "force-stop", package), ("reverse", "--remove", "tcp:18787")]:
            try:
                adb(*command)
            except subprocess.CalledProcessError:
                pass
        server.shutdown()


if __name__ == "__main__":
    main()
