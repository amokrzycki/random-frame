"""Summarize a native retention run: process-tree PSS/RSS at checkpoints, CPU, latency, cache reads.

Usage: python performance/native-retention-summary.py /tmp/rf-after-1000 [more run dirs...]
Reads run-N.json and resources-N.json (plain or .gz). Prints one JSON document.
"""

import gzip
import json
import math
import sys
from pathlib import Path

MIB = 1024


def load(path):
    for candidate in (path, Path(str(path) + ".gz")):
        if candidate.exists():
            opener = gzip.open if candidate.suffix == ".gz" else open
            with opener(candidate, "rt") as file:
                return json.load(file)
    raise FileNotFoundError(path)


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def nearest(resources, at):
    # Samples taken while the process tree was already exiting read zero; skip them.
    live = [sample for sample in resources if sample["pssKiB"] > 0]
    return min(live, key=lambda sample: abs(sample["epochMs"] - at))


def cpu_seconds(resources, start, end, ticks):
    """Per-process tick deltas inside [start, end], so exited children still count."""
    first, last = {}, {}
    for sample in resources:
        if not start - 250 <= sample["epochMs"] <= end + 250:
            continue
        for process in sample["processes"]:
            first.setdefault(process["pid"], process["cpuTicks"])
            last[process["pid"]] = process["cpuTicks"]
    return sum(last[pid] - first[pid] for pid in last) / ticks


def summarize(directory):
    directory = Path(directory)
    run = load(directory / "run-0.json")
    resources = load(directory / "resources-0.json")
    metadata = load(directory / "metadata.json")
    retention = run["retention"]
    ticks = metadata.get("clockTicks", 100)
    checkpoints = []
    for checkpoint in retention["checkpoints"]:
        sample = nearest(resources, checkpoint["at"])
        checkpoints.append(
            {
                "name": checkpoint["name"],
                "pssMiB": round(sample["pssKiB"] / MIB, 1),
                "rssMiB": round(sample["rssKiB"] / MIB, 1),
                "loaded": checkpoint["loaded"],
                "dataUrlMiB": round(checkpoint["dataUrlChars"] / MIB / MIB, 1),
                "reads": checkpoint["reads"],
                "saves": checkpoint["saves"],
                "sourceCalls": checkpoint["sourceCalls"],
            }
        )
    latencies = {}
    for name, samples in retention["latencies"].items():
        ms = [sample["ms"] for sample in samples]
        reads = [sample["reads"] for sample in samples]
        latencies[name] = {
            "n": len(ms),
            "medianMs": round(percentile(ms, 0.5), 1),
            "p95Ms": round(percentile(ms, 0.95), 1),
            "meanReads": round(sum(reads) / len(reads), 1),
            "totalReads": sum(reads),
        }
    started = retention["checkpoints"][0]["at"]
    finished = retention["checkpoints"][-1]["at"]
    live = [sample for sample in resources if sample["epochMs"] >= started]
    return {
        "directory": str(directory),
        "build": metadata.get("build", {}).get("baseline"),
        "library": retention["library"],
        "diskFiles": [retention["filesBefore"], retention["filesAfter"]],
        "startupReadyMs": run["startup"]["ready"],
        "peakPssMiB": round(max(sample["pssKiB"] for sample in resources) / MIB, 1),
        "peakRssMiB": round(max(sample["rssKiB"] for sample in resources) / MIB, 1),
        "workloadPeakPssMiB": round(max(sample["pssKiB"] for sample in live) / MIB, 1),
        "workloadCpuSeconds": round(cpu_seconds(resources, started, finished, ticks), 1),
        "checkpoints": checkpoints,
        "latencies": latencies,
        "fingerprints": load(directory / "disk-fingerprints.json") if (directory / "disk-fingerprints.json").exists() else None,
    }


if __name__ == "__main__":
    print(json.dumps([summarize(directory) for directory in sys.argv[1:]], indent=2))
