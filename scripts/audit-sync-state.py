#!/usr/bin/env python3
"""Read-only Sync forensics. Output aggregates only, never snapshot contents/IDs.

Usage: python3 scripts/audit-sync-state.py LINUX_BEFORE LINUX_AFTER WINDOWS_AFTER
Legacy repair projections use the incident's Europe/Warsaw calendar. They are
counterfactual calculations only; this tool never repairs or writes app data.
"""

import collections
import datetime
import json
import pathlib
import sys
import zoneinfo


def read(directory, name):
    return json.loads((directory / name).read_bytes())


def activity_counts(data):
    counts = collections.Counter()
    for operation in data["operations"]:
        kind, value = next(iter(operation.items()))
        if kind == "LegacyImport":
            counts["legacy_imports"] += 1
            counts["legacy_viewed_total"] += value["viewed_total"]
        else:
            counts[value["outcome"].lower() + "_discoveries"] += 1
    return {
        "operations": len(data["operations"]),
        "removed": len(data["removed"]),
        "viewed_total": counts["legacy_viewed_total"] + counts["viewed_discoveries"],
        **dict(counts),
    }


def audit(directory):
    legacy = read(directory, "activity.json")
    activity = read(directory, "activity-v2.json")
    history = read(directory, "history-v3.json")
    zone = zoneinfo.ZoneInfo("Europe/Warsaw")
    first_views = collections.Counter(
        datetime.datetime.fromtimestamp(item["viewedAt"] / 1000, zone).strftime("%Y-%m-%d")
        for item in history["history"]
        if item["source"] == "prntsc"
    )
    excess = sum(
        max(0, counts["viewed"] - first_views[day])
        for day, counts in legacy["days"].items()
    )
    exploration = read(directory, "exploration-v2.json")["records"]
    return {
        "activity": activity_counts(activity),
        "legacy_activity": {
            "viewed_total": legacy["viewed_total"],
            "daily_viewed_sum": sum(day["viewed"] for day in legacy["days"].values()),
            "migrated": legacy["migrated"],
            "revisit_views_repaired": legacy["revisit_views_repaired"],
        },
        "history": {
            "entries": len(history["history"]),
            "operations": len(history["history_ops"]),
            "removed": len(history["removed_history_ops"]),
            "unique_prntsc": len(
                {item["id"] for item in history["history"] if item["source"] == "prntsc"}
            ),
            "old_prntsc_views_per_day_sum": sum(first_views.values()),
            "counterfactual_old_repair_total": max(0, legacy["viewed_total"] - excess),
            "old_repair_would_run": not legacy["revisit_views_repaired"],
        },
        "exploration": {
            "records": len(exploration),
            "viewable": sum(bool(item["evidence"] & 1) for item in exploration),
        },
        "migration_receipts": read(directory, "state-migration.json"),
        "atomic_recovery_file_count": sum(
            path.suffix in {".tmp", ".bak"} for path in directory.iterdir()
        ),
    }


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    before, after, windows = map(pathlib.Path, sys.argv[1:])
    pre = read(before, "history-v3.json")
    post = read(after, "history-v3.json")
    win = read(windows, "history.json")
    pre_ids = {tuple(item["operation_id"]) for item in pre["history_ops"]}
    post_ids = {tuple(item["operation_id"]) for item in post["history_ops"]}
    legacy_removals = {tuple(item) for item in win["removed_history_ops"]}
    lost = pre_ids - post_ids
    report = {
        "linux_before": audit(before),
        "linux_after": audit(after),
        "windows_after": audit(windows),
        "history_lineage": {
            "before_operations": len(pre_ids),
            "surviving_before_operations": len(pre_ids & post_ids),
            "lost_before_operations": len(lost),
            "lost_matching_windows_legacy_removals": len(lost & legacy_removals),
            "new_after_operations": len(post_ids - pre_ids),
            "windows_legacy_removals": len(legacy_removals),
            "post_removals_equal_windows_legacy": legacy_removals
            == {tuple(item) for item in post["removed_history_ops"]},
        },
    }
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
