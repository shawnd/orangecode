#!/usr/bin/env python3
"""Run the actual native daemon harness under one external shared flock."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys


def distribution(values):
    return {"median": statistics.median(values), "min": min(values), "max": max(values)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("post")
    parser.add_argument("output")
    parser.add_argument("--reuse", action="store_true", help="reuse completed samples after validating provenance")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    summary = {}
    hashes = {arm: hashlib.sha256(Path(binary).read_bytes()).hexdigest()
              for arm, binary in [("base", args.baseline), ("post", args.post)]}
    for backend in ["worker", "direct"]:
        for core in ["legacy", "v2"]:
            samples = {"base": [], "post": []}
            for repeat in range(1, 4):
                for arm in (["base", "post"] if repeat % 2 else ["post", "base"]):
                    artifact = output / f"{backend}-{core}-{arm}-{repeat}.json"
                    if not (args.reuse and artifact.exists()):
                        subprocess.run([
                            sys.executable, str(Path(__file__).with_name("bench-server-lifetimes.py")),
                            args.baseline if arm == "base" else args.post, str(artifact),
                            "--arm", arm, "--core", core, "--backend", backend,
                        ], check=True)
                    row = json.loads(artifact.read_text())
                    if (row["sha256"], row["arm"], row["core"], row["backend"]) != (hashes[arm], arm, core, backend):
                        raise RuntimeError(f"{artifact}: provenance mismatch")
                    samples[arm].append(row)
            summary[f"{backend}-{core}"] = {}
            for arm, rows in samples.items():
                metrics = {f"{stage}_{key}": distribution([row[stage][key] for row in rows])
                           for stage in ["ready", "churn", "idle", "revisited", "revisit_idle"]
                           for key in ["pss_kib", "rss_kib", "threads", "fds", "inotify_watches", "cpu_ms"]}
                metrics.update({
                    "first_cold_ms": distribution([row["cold_ms"][0] for row in rows]),
                    "cold_ms": distribution([time for row in rows for time in row["cold_ms"][1:]]),
                    "warm_ms": distribution([time for row in rows for time in row["warm_ms"]]),
                    "revisit_ms": distribution([row["revisit_ms"] for row in rows]),
                    "revisit_ready_ms": distribution([row["revisit_ready_ms"] for row in rows]),
                    "churn_cpu_ms": distribution([row["churn"]["cpu_ms"] - row["ready"]["cpu_ms"] for row in rows]),
                    "idle_cpu_ms": distribution([row["idle"]["cpu_ms"] - row["churn"]["cpu_ms"] for row in rows]),
                    "revisit_cpu_ms": distribution([row["revisited"]["cpu_ms"] - row["idle"]["cpu_ms"] for row in rows]),
                    "idle_workers": distribution([row["idle"]["thread_names"].count("fff") for row in rows]),
                    "idle_native_watcher_threads": distribution([
                        sum(name.startswith("notify-rs") or name == "fff-watcher-own"
                            for name in row["idle"]["thread_names"]) for row in rows]),
                    "fresh_file_visible": all(row["fresh_file_visible"] for row in rows),
                    "binary_sha256": rows[0]["sha256"], "version": rows[0]["version"],
                })
                if arm == "post":
                    cleanup = [next((sample["elapsed_ms"] for sample in row["idle_observations"]
                                     if not any(name == "fff" or name.startswith("notify-rs") or name == "fff-watcher-own"
                                                for name in sample["thread_names"])), None) for row in rows]
                    if any(value is None for value in cleanup):
                        raise RuntimeError(f"{backend}/{core}: idle cleanup did not complete")
                    if metrics["idle_workers"]["max"] != 0:
                        raise RuntimeError(f"{backend}/{core}: retained idle worker")
                    metrics["cleanup_native_threads_ms"] = distribution(cleanup)
                summary[f"{backend}-{core}"][arm] = metrics
    summary["artifact_sha256"] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in sorted(output.glob("*.json*")) if path.name != "summary.json"}
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
