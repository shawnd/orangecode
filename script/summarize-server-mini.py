#!/usr/bin/env python3
"""Summarize independent paired MINI samples without confidence claims."""
import json
import pathlib
import statistics
import sys


samples = json.loads(pathlib.Path(sys.argv[1]).read_text())
for count in sorted({sample["n"] for sample in samples}):
    rows = {}
    for arm in ["baseline", "candidate"]:
        selected = [sample for sample in samples if sample["n"] == count and sample["arm"] == arm]
        if not selected:
            continue
        values = {
            "fleet_pss_mib": [sample["fleet_pss_kib"] / 1024 for sample in selected],
            "clients_pss_mib": [sample["clients_pss_kib"] / 1024 for sample in selected],
            "startup_client_cpu_ms": [sum(process["cpu_ms"] for process in sample["startup_clients"]) for sample in selected],
            "settling_client_cpu_ms": [sum(next(final["cpu_ms"] for final in sample["processes"] if final["pid"] == process["pid"]) - process["cpu_ms"]
                                           for process in sample["startup_clients"]) for sample in selected],
            "readiness_ms": [statistics.median(sample["readiness_ms"]) for sample in selected],
        }
        rows[arm] = {name: {"median": statistics.median(data), "min": min(data), "max": max(data), "samples": data}
                     for name, data in values.items()}
    print(json.dumps({"n": count, "arms": rows}), flush=True)
