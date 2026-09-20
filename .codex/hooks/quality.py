#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path

BIOME_SUFFIXES = {
    ".astro",
    ".cjs",
    ".css",
    ".gql",
    ".graphql",
    ".grit",
    ".html",
    ".js",
    ".json",
    ".jsonc",
    ".jsx",
    ".mjs",
    ".mts",
    ".svelte",
    ".ts",
    ".tsx",
    ".vue",
}


def run(root: Path, *command: str, stop_event: bool = False) -> None:
    print(f"+ {' '.join(command)}", file=sys.stderr if stop_event else sys.stdout)
    subprocess.run(
        command,
        cwd=root,
        check=True,
        stdout=sys.stderr if stop_event else None,
        stderr=None,
    )


def git_paths(root: Path) -> set[str]:
    commands = (
        ("git", "diff", "--name-only", "-z", "--diff-filter=ACMRTUXB"),
        ("git", "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTUXB"),
        ("git", "ls-files", "--others", "--exclude-standard", "-z"),
    )
    paths: set[str] = set()
    for command in commands:
        output = subprocess.check_output(command, cwd=root)
        paths.update(part.decode() for part in output.split(b"\0") if part)
    return paths


def patch_paths(payload: dict) -> set[str]:
    command = payload.get("tool_input", {}).get("command")
    if not isinstance(command, str):
        return set()

    paths: set[str] = set()
    for line in command.splitlines():
        for marker in ("*** Add File: ", "*** Update File: ", "*** Move to: "):
            if line.startswith(marker):
                paths.add(line.removeprefix(marker))
    return paths


def existing_repo_paths(root: Path, paths: set[str]) -> list[str]:
    result = []
    for path in sorted(paths):
        absolute = (root / path).resolve()
        if absolute.is_relative_to(root) and absolute.is_file():
            result.append(str(absolute.relative_to(root)))
    return result


def post_edit(root: Path, payload: dict) -> None:
    paths = existing_repo_paths(root, patch_paths(payload) or git_paths(root))
    biome_paths = [
        path for path in paths if Path(path).suffix.lower() in BIOME_SUFFIXES
    ]
    rust_changed = any(Path(path).suffix.lower() == ".rs" for path in paths)

    if biome_paths:
        run(
            root,
            "npm",
            "run",
            "lint",
            "--",
            "--write",
            "--files-ignore-unknown=true",
            "--no-errors-on-unmatched",
            *biome_paths,
        )
        run(root, "npm", "run", "typecheck")

    if rust_changed:
        run(root, "cargo", "fmt", "--manifest-path", "src-tauri/Cargo.toml")
        run(
            root,
            "cargo",
            "check",
            "--locked",
            "--manifest-path",
            "src-tauri/Cargo.toml",
        )


def final_check(root: Path, payload: dict) -> int:
    stop_event = payload.get("hook_event_name") == "Stop"
    if stop_event and payload.get("stop_hook_active"):
        print("{}")
        return 0

    commands = (
        ("npm", "run", "lint"),
        ("npm", "run", "typecheck"),
        ("npm", "test"),
        ("cargo", "fmt", "--check", "--manifest-path", "src-tauri/Cargo.toml"),
        (
            "cargo",
            "clippy",
            "--locked",
            "--manifest-path",
            "src-tauri/Cargo.toml",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--",
            "-D",
            "warnings",
        ),
        (
            "cargo",
            "test",
            "--locked",
            "--manifest-path",
            "src-tauri/Cargo.toml",
            "--workspace",
            "--all-features",
        ),
    )
    try:
        for command in commands:
            run(root, *command, stop_event=stop_event)
    except subprocess.CalledProcessError as error:
        if stop_event:
            print(
                json.dumps(
                    {
                        "decision": "block",
                        "reason": (
                            f"Full quality gate failed: {' '.join(error.cmd)}. "
                            "Fix it and rerun the full quality gate before finishing."
                        ),
                    }
                )
            )
            return 0
        return error.returncode

    if stop_event:
        print("{}")
    return 0


def main() -> int:
    hook_input = sys.stdin.read()
    payload = json.loads(hook_input) if hook_input.strip() else {}
    root = Path(
        subprocess.check_output(
            ("git", "rev-parse", "--show-toplevel"), text=True
        ).strip()
    )
    if sys.argv[1:] == ["edit"]:
        post_edit(root, payload)
        return 0
    if sys.argv[1:] == ["final"]:
        return final_check(root, payload)
    print("usage: quality.py edit|final", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
