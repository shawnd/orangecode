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


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, endpoint):
        super().__init__("opencode.internal", timeout=30)
        self.endpoint = endpoint

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.endpoint)


def live_contents(paths):
    for path in paths:
        try:
            yield path.read_text()
        except FileNotFoundError:
            pass  # A native worker/FD may exit during an idle observation.


def resources(pid):
    proc = Path(f"/proc/{pid}")
    memory = dict((line.split(":")[0], int(line.split()[1]))
                  for line in (proc / "smaps_rollup").read_text().splitlines()[1:])
    names = [name.strip() for name in live_contents(task / "comm" for task in (proc / "task").iterdir())]
    fdinfos = list(live_contents((proc / "fdinfo").iterdir()))
    cpu = (proc / "stat").read_text().split(") ", 1)[1].split()
    return {"pss_kib": memory["Pss"], "rss_kib": memory["Rss"],
            "threads": len(names), "thread_names": names,
            "fds": len(fdinfos),
            "inotify_watches": sum(text.count("inotify wd:") for text in fdinfos),
            "cpu_ms": (int(cpu[11]) + int(cpu[12])) * 1000 / os.sysconf("SC_CLK_TCK")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("output")
    parser.add_argument("--arm", choices=["base", "post"], required=True)
    parser.add_argument("--core", choices=["legacy", "v2"], required=True)
    parser.add_argument("--projects", type=int, default=8)
    parser.add_argument("--backend", choices=["worker", "direct"], default="worker")
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
                "OPENCODE_EXPERIMENTAL_FFF_WORKER": "1" if args.backend == "worker" else "0",
                "OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS": "1000" if args.arm == "post" else ""})
    Path(env["HOME"]).mkdir()
    log = open(str(output) + ".daemon.log", "w")
    process = subprocess.Popen([binary, "server", "--daemon"], cwd=root, env=env,
                               stdout=log, stderr=log)
    result = {"arm": args.arm, "core": args.core, "binary": binary,
              "sha256": hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
              "version": subprocess.check_output([binary, "--version"], text=True).strip(),
              "projects": args.projects, "files_per_project": 100, "idle_ms": 1000,
              "backend": args.backend, "idle_interval_ms": 2500,
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

    def find(directory, query="needle"):
        route = ("/find/file" if args.core == "legacy" else "/api/fs/find") + f"?query={query}&type=file&limit=10"
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
        idle_started = time.monotonic()
        result["idle_observations"] = []
        while time.monotonic() - idle_started < 2.5:
            time.sleep(0.1)  # Same observation schedule, no forced GC.
            sample = resources(process.pid)
            result["idle_observations"].append({"elapsed_ms": (time.monotonic() - idle_started) * 1000,
                                                **sample})
        result["idle"] = resources(process.pid)
        (projects[0] / "fresh-after-idle.ts").write_text("new index entry\n")
        revisit_started = time.monotonic()
        count, result["revisit_ms"] = find(projects[0])
        deadline = time.monotonic() + 5
        while not count:
            if time.monotonic() > deadline:
                raise RuntimeError("reopened search scan not ready")
            time.sleep(0.02)
            count, _ = find(projects[0])
        result["revisit_ready_ms"] = (time.monotonic() - revisit_started) * 1000
        deadline = time.monotonic() + 5
        while not find(projects[0], "fresh-after-idle")[0]:
            if time.monotonic() > deadline:
                raise RuntimeError("reopened search did not observe new file")
            time.sleep(0.02)
        result["fresh_file_visible"] = True
        result["revisited"] = resources(process.pid)
        time.sleep(2.5)
        result["revisit_idle"] = resources(process.pid)
        # Untimed diagnostic: identify retained project/HEAD watches without
        # confusing them with the retired native search watch threads.
        known = {f"ino:{entry.stat().st_ino:x} ": str(entry.relative_to(root))
                 for project in projects
                 for entry in [project, project / ".git", project / ".git" / "HEAD", project / "opencode.json"]}
        watches = [line for info in live_contents((Path(f"/proc/{process.pid}") / "fdinfo").iterdir())
                   for line in info.splitlines() if line.startswith("inotify wd:")]
        result["retained_watch_paths"] = [next((name for inode, name in known.items() if inode in line), line)
                                           for line in watches]
        output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"arm": args.arm, "core": args.core, "backend": args.backend,
                          "idle_pss_kib": result["idle"]["pss_kib"],
                          "idle_workers": result["idle"]["thread_names"].count("fff"),
                          "idle_watches": result["idle"]["inotify_watches"],
                          "revisit_ms": result["revisit_ms"], "artifact": str(output)}))
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
