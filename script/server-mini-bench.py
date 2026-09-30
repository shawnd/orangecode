#!/usr/bin/env python3
"""Linux real-PTY MINI experiment. Run under the shared benchmark flock.

No third-party packages; fixtures are isolated from user config. The provider
implements deterministic OpenAI chat completions, including real tool rounds.
"""
import argparse
import base64
import fcntl
import hashlib
import http.server
import http.client
import json
import os
import pathlib
import pty
import select
import signal
import socket
import statistics
import struct
import subprocess
import termios
import threading
import time
import urllib.parse
import urllib.request


def sha(path):
    return hashlib.file_digest(open(path, "rb"), "sha256").hexdigest()


class Provider(http.server.BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Provider.calls.append(body)
        messages = body.get("messages", [])
        user = next((m.get("content", "") for m in reversed(messages) if m["role"] == "user"), "")
        text = json.dumps(user)
        tools = "mini-tool" in text and not any(m["role"] == "tool" for m in messages)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if "mini-slow" in text:
            time.sleep(3)
        delta = {"tool_calls": [{"index": 0, "id": "call_mini", "type": "function", "function": {
            "name": "bash", "arguments": json.dumps({"command": "printf mini-tool-output", "description": "Print mini marker"})
        }}]} if tools else {"content": "MINI deterministic response"}
        chunk = {"id": "mini-completion", "object": "chat.completion.chunk", "created": 1, "model": "mini", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
        finish = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tools else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        try:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: " + json.dumps(finish) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def environment(root, port):
    root.mkdir(parents=True, exist_ok=True)
    for folder in ["home", "config", "data", "state", "cache", "runtime", "project"]:
        (root / folder).mkdir(exist_ok=True)
    config = {
        "model": "mini/mini", "small_model": "mini/mini", "enabled_providers": ["mini"],
        "permission": {"*": "allow", "bash": "ask"},
        "provider": {"mini": {"npm": "@ai-sdk/openai-compatible", "name": "Mini deterministic", "options": {
            "baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "isolated-test"
        }, "models": {"mini": {"name": "Mini", "limit": {"context": 8192, "output": 1024}}}}},
    }
    return {
        "PATH": os.environ["PATH"], "HOME": str(root / "home"), "PWD": str(root / "project"),
        **{f"XDG_{key}_HOME": str(root / value) for key, value in [("CONFIG", "config"), ("DATA", "data"), ("STATE", "state"), ("CACHE", "cache")]},
        "XDG_RUNTIME_DIR": str(root / "runtime"), "TERM": "xterm-256color", "COLORTERM": "truecolor",
        "OPENCODE_DAEMON_DIR": str(root / "daemon"), "OPENCODE_CONFIG_CONTENT": json.dumps(config),
        "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1", "OPENCODE_DISABLE_CLAUDE_CODE": "1",
        "OPENCODE_DISABLE_LSP_DOWNLOAD": "1", "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
        "OPENCODE_PURE": "1", "OPENCODE_TEST_HOME": str(root / "home"),
    }


class Terminal:
    def __init__(self, binary, args, env, log):
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        def setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.start = time.monotonic()
        self.process = subprocess.Popen([binary, *args], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=env["PWD"], preexec_fn=setup)
        os.close(slave)
        self.output = bytearray()
        self.log = log
        self.ready_ms = None

    def drain(self, timeout=0.02):
        if select.select([self.fd], [], [], timeout)[0]:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            self.output.extend(data)
            # Respond to terminal queries equally in both arms.
            if b"\x1b[6n" in data:
                os.write(self.fd, b"\x1b[1;1R")
            if b"]10;?" in data:
                os.write(self.fd, b"\x1b]10;rgb:dddd/dddd/dddd\x07")
            if b"]11;?" in data:
                os.write(self.fd, b"\x1b]11;rgb:1111/1111/1111\x07")
            if self.ready_ms is None and b"Ask anything" in self.output and b"BUILD" in self.output:
                self.ready_ms = (time.monotonic() - self.start) * 1000

    def send(self, text):
        os.write(self.fd, text.encode())

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.log.write_bytes(self.output)
        os.close(self.fd)


def api(endpoint, env, route, body=None):
    headers = {
        "Authorization": "Basic " + base64.b64encode(("opencode:" + endpoint["password"]).encode()).decode(),
        "Content-Type": "application/json", "x-opencode-directory": env["PWD"],
    }
    if endpoint.get("socket"):
        conn = http.client.HTTPConnection("localhost", timeout=15)
        conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.sock.settimeout(15)
        conn.sock.connect(endpoint["socket"])
        conn.request("GET" if body is None else "POST", route, body=None if body is None else json.dumps(body), headers=headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        if response.status != 200:
            raise RuntimeError(data)
        return json.loads(data)
    request = urllib.request.Request(endpoint["url"] + route, data=None if body is None else json.dumps(body).encode(), headers=headers)
    return json.load(urllib.request.urlopen(request, timeout=15))


def metrics(pid):
    proc = pathlib.Path(f"/proc/{pid}")
    smaps = dict((line.split(":")[0], int(line.split()[1])) for line in (proc / "smaps_rollup").read_text().splitlines()[1:] if ":" in line)
    stat = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": pid, "pss_kib": smaps["Pss"], "rss_kib": smaps["Rss"], "cpu_ms": (int(stat[11]) + int(stat[12])) * 1000 / os.sysconf("SC_CLK_TCK")}


def descendants(pid):
    found = {pid}
    pending = [pid]
    while pending:
        parent = pending.pop()
        for task in pathlib.Path(f"/proc/{parent}/task").glob("*/children"):
            for child in task.read_text().split():
                if int(child) not in found:
                    found.add(int(child))
                    pending.append(int(child))
    return found


def drain_until(clients, condition, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for client in clients:
            client.drain()
            if client.process.poll() is not None:
                raise RuntimeError(bytes(client.output).decode(errors="replace"))
        if condition():
            return
    raise TimeoutError("PTY readiness/flow deadline")


def sample(binary, root, port, n, settle, trace=False):
    env = environment(root, port)
    clients = []
    daemon = None
    endpoint = None
    try:
        # Bring up the shared daemon outside client startup. Both artifacts own
        # their own daemon, config, catalog and database, no production profile.
        result = subprocess.run([binary, "server", "start"], env=env, cwd=env["PWD"], capture_output=True, timeout=45)
        (root / "server-start.txt").write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(result.stderr.decode())
        endpoint = json.loads((root / "daemon/server.json").read_text())
        status = api(endpoint, env, "/__daemon/status")
        daemon = status["pid"]
        endpoint = api(endpoint, env, "/__daemon/listen", {})
        # Warm the backend location symmetrically; measure warm attachments.
        api(endpoint, env, "/config/providers")
        before = metrics(daemon)
        for i in range(n):
            args = ["attach", endpoint["url"], "--mini", "--dir", env["PWD"], "--password", endpoint["password"]]
            cmd = binary
            if trace:
                args = ["-ff", "-tt", "-e", "trace=file", "-o", str(root / "syscalls"), binary, *args]
                cmd = "/usr/bin/strace"
            clients.append(Terminal(cmd, args, env, root / f"client-{i}.pty"))
        drain_until(clients, lambda: all(c.ready_ms is not None for c in clients))
        startup = [metrics(c.process.pid) for c in clients]
        end = time.monotonic() + settle
        while time.monotonic() < end:
            for c in clients:
                c.drain()
        ids = set.union(descendants(daemon), *(descendants(c.process.pid) for c in clients))
        processes = [metrics(pid) for pid in sorted(ids)]
        record = {"binary": binary, "sha256": sha(binary), "n": n, "settle_s": settle, "readiness_ms": [c.ready_ms for c in clients], "startup_clients": startup, "daemon_before": before, "processes": processes,
                  "fleet_pss_kib": sum(p["pss_kib"] for p in processes), "clients_pss_kib": sum(p["pss_kib"] for p in processes if p["pid"] != daemon)}
        (root / "sample.json").write_text(json.dumps(record, indent=2))
        print(json.dumps(record), flush=True)
        return record
    finally:
        for c in clients:
            c.close()
        if endpoint:
            subprocess.run([binary, "server", "stop"], env=env, cwd=env["PWD"], capture_output=True, timeout=15)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate")
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--settle", type=float, default=5)
    parser.add_argument("--trace", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    artifacts = {"baseline": args.baseline, **({"candidate": args.candidate} if args.candidate else {})}
    hashes = {name: sha(binary) for name, binary in artifacts.items()}
    (args.out / "hashes-before.json").write_text(json.dumps(hashes, indent=2))
    samples = []
    try:
        for repeat in range(args.repeats):
            for n in [1, 4]:
                order = list(artifacts.items())
                if repeat % 2:
                    order.reverse()
                for name, binary in order:
                    assert sha(binary) == hashes[name]
                    record = sample(binary, args.out / f"r{repeat}-n{n}-{name}", provider.server_port, n, args.settle, args.trace)
                    samples.append({"arm": name, "repeat": repeat, **record})
        (args.out / "samples.json").write_text(json.dumps(samples, indent=2))
        (args.out / "provider-requests.json").write_text(json.dumps(Provider.calls, indent=2))
        assert {name: sha(binary) for name, binary in artifacts.items()} == hashes
        (args.out / "hashes-after.json").write_text(json.dumps(hashes, indent=2))
    finally:
        provider.shutdown()


if __name__ == "__main__":
    main()
