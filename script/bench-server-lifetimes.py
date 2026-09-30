#!/usr/bin/env python3
"""Run under the shared flock. Measures a private native daemon, never installed oc."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, endpoint):
        super().__init__("opencode.internal", timeout=30)
        self.endpoint = endpoint

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.endpoint)


def resources(pid):
    proc = Path(f"/proc/{pid}")
    memory = dict((line.split(":")[0], int(line.split()[1]))
                  for line in (proc / "smaps_rollup").read_text().splitlines()[1:])
    names = [(task / "comm").read_text().strip() for task in (proc / "task").iterdir()]
    fdinfos = [fd.read_text() for fd in (proc / "fdinfo").iterdir()]
    return {"pss_kib": memory["Pss"], "rss_kib": memory["Rss"],
            "threads": len(names), "thread_names": names,
            "fds": len(fdinfos),
            "inotify_watches": sum(text.count("inotify wd:") for text in fdinfos)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("output")
    parser.add_argument("--arm", choices=["base", "post"], required=True)
    parser.add_argument("--core", choices=["legacy", "v2"], required=True)
    parser.add_argument("--projects", type=int, default=8)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="lifetimes-", dir="/tmp/opencode"))
    daemon = root / "daemon"
    daemon.mkdir()
    projects = []
    for index in range(args.projects):
        directory = root / f"project-{index}"
        directory.mkdir()
        subprocess.run(["git", "init", "-q", str(directory)], check=True)
        (directory / "opencode.json").write_text(json.dumps({"plugin": [], "autoupdate": False,
                                                            "enabled_providers": []}))
        for file in range(100):
            (directory / f"needle-{file}.ts").write_text("export const needle = 1\n" * 10)
        projects.append(directory)
    env = {key: value for key, value in os.environ.items()
           if not (key.startswith("OPENCODE_") or key.endswith("API_KEY") or key.startswith("XDG_"))}
    env.update({"HOME": str(root / "home"), "XDG_DATA_HOME": str(root / "data"),
                "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
                "XDG_STATE_HOME": str(root / "state"), "OPENCODE_DAEMON_DIR": str(daemon),
                "OPENCODE_SERVER_PASSWORD": "lifetimes-local-only", "OPENCODE_PURE": "1",
                "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_AUTOUPDATE": "1",
                "OPENCODE_EXPERIMENTAL_FFF_WORKER": "1",
                "OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS": "1000" if args.arm == "post" else ""})
    Path(env["HOME"]).mkdir()
    log = open(str(output) + ".daemon.log", "w")
    process = subprocess.Popen([binary, "server", "--daemon"], cwd=root, env=env,
                               stdout=log, stderr=log)
    result = {"arm": args.arm, "core": args.core, "binary": binary,
              "sha256": hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
              "version": subprocess.check_output([binary, "--version"], text=True).strip(),
              "projects": args.projects, "files_per_project": 100, "idle_ms": 1000,
              "scope": "native daemon only; worker threads included once; no client/helper PSS"}
    auth = "Basic b3BlbmNvZGU6bGlmZXRpbWVzLWxvY2FsLW9ubHk="

    def request(route, directory=None):
        connection = UnixHTTP(str(daemon / "server.sock"))
        headers = {"Authorization": auth}
        if directory:
            headers["x-opencode-directory"] = str(directory)
        started = time.perf_counter()
        connection.request("GET", route, headers=headers)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        if response.status != 200:
            raise RuntimeError(f"{route}: {response.status} {body[:2000]!r}")
        return json.loads(body), (time.perf_counter() - started) * 1000

    def find(directory):
        route = "/find/file?query=needle&type=file&limit=10" if args.core == "legacy" else "/api/fs/find?query=needle&type=file&limit=10"
        value, elapsed = request(route, directory)
        data = value if args.core == "legacy" else value["data"]
        return len(data), elapsed

    try:
        deadline = time.monotonic() + 30
        while not (daemon / "server.json").exists():
            if process.poll() is not None:
                raise RuntimeError("daemon exited at startup")
            if time.monotonic() > deadline:
                raise RuntimeError("daemon startup timeout")
            time.sleep(0.02)
        request("/global/health")
        result["ready"] = resources(process.pid)
        result["cold_ms"] = []
        for directory in projects:
            count, elapsed = find(directory)
            result["cold_ms"].append(elapsed)
            deadline = time.monotonic() + 5
            while not count:
                if time.monotonic() > deadline:
                    raise RuntimeError("search scan not ready")
                time.sleep(0.02)
                count, _ = find(directory)
        result["churn"] = resources(process.pid)
        result["warm_ms"] = [find(projects[-1])[1] for _ in range(10)]
        time.sleep(2.5)  # Measured idle interval, same for both arms, no forced GC.
        result["idle"] = resources(process.pid)
        (projects[0] / "fresh-after-idle.ts").write_text("new index entry\n")
        result["revisit_ms"] = find(projects[0])[1]
        result["revisited"] = resources(process.pid)
        output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({key: value for key, value in result.items() if key not in ["cold_ms", "warm_ms"]}))
    finally:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
