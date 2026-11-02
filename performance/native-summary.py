"""Summarize native-run artifacts without conflating layout work and frame opportunities."""
import argparse
import gzip
import json
import math
from pathlib import Path
import statistics


def distribution(values):
    values = sorted(values)
    return {"n": len(values), "median": statistics.median(values), "p95": values[math.ceil(len(values) * 0.95) - 1], "max": values[-1]} if values else None


def summarize(directory):
    directory = Path(directory)
    metadata = json.loads((directory / "metadata.json").read_text())
    runs = []
    observations = {}
    def read_json(file):
        return json.loads(gzip.decompress(file.read_bytes()) if file.suffix == ".gz" else file.read_text())

    for file in sorted(directory.glob("run-*.json*")):
        report = read_json(file)
        if "error" in report:
            runs.append({"file": file.name, "error": report["error"]})
            continue
        resource_file = directory / file.name.replace("run-", "resources-")
        all_resources = read_json(resource_file)
        # A process can exit between poll() and /proc traversal. Absence is not zero RSS.
        resources = [sample for sample in all_resources if sample["processes"] and sample["rssKiB"] > 0]
        offset = report["startup"]["launchToTimeOrigin"]
        startup = {name: value + offset for name, value in report["startup"].items() if name not in ["timeOrigin", "launchToTimeOrigin"]}
        # Record maximum lifetime CPU ticks per PID, including processes that exit before the app.
        cpu = {}
        names = {}
        startup_cpu = {}
        for sample in all_resources:
            for process in sample["processes"]:
                cpu[process["pid"]] = max(cpu.get(process["pid"], 0), process["cpuTicks"])
                names[process["pid"]] = process["name"]
                if sample["elapsed"] * 1000 <= offset + report["startup"]["ready"]:
                    startup_cpu[process["pid"]] = max(startup_cpu.get(process["pid"], 0), process["cpuTicks"])
        checkpoints = []
        for checkpoint in report["resources"]:
            nearest = min(resources, key=lambda sample: abs(sample["elapsed"] * 1000 - offset - checkpoint["at"]))
            checkpoints.append({**checkpoint, "rssMiB": nearest["rssKiB"] / 1024})
        frame_phases = {}
        for frame in report["frames"]:
            frame_phases.setdefault(frame["phase"], []).append(frame["gap"])
        frames = {phase: {**distribution(values), "over25ms": sum(value > 25 for value in values), "over50ms": sum(value > 50 for value in values)} for phase, values in frame_phases.items()}
        spans = {}
        for span in report["spans"]:
            spans.setdefault(f'{span["phase"]}/{span["name"]}', []).append(span["duration"])
        ipc = {}
        for span in report["ipc"]:
            ipc.setdefault(f'{span["phase"]}/{span["name"]}', []).append(span["duration"])
        for key, values in report["observations"].items():
            if isinstance(values, list):
                # OpenOnly arrays are recorded inside the action and include the three warmups.
                observations.setdefault(key, []).extend(values[3:] if key.endswith("Only") else values)
        runs.append({"file": file.name, "startupMs": startup, "peakRssMiB": max(sample["rssKiB"] for sample in resources) / 1024, "cpuSeconds": sum(cpu.values()) / metadata["clockTicks"], "startupCpuSecondsApprox": sum(startup_cpu.values()) / metadata["clockTicks"], "cpuByProcess": [{"name": names[pid], "seconds": ticks / metadata["clockTicks"]} for pid, ticks in cpu.items()], "durationSeconds": resources[-1]["elapsed"], "checkpoints": checkpoints, "frames": frames, "spans": {key: distribution(values) for key, values in spans.items()}, "ipc": {key: distribution(values) for key, values in ipc.items()}, "longNavigations": report["observations"]["longNavigations"]})
    return {"metadata": metadata, "runs": runs, "observations": {key: distribution(values) for key, values in observations.items()}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directories", nargs="+")
    args = parser.parse_args()
    print(json.dumps({str(directory): summarize(directory) for directory in args.directories}, indent=2))
