#!/usr/bin/env python3
"""Real compiled MINI PTY/provider/permission/resume/fork smoke.

Run separately from timed memory samples under shared-server-bench.lock.
"""
import argparse
import importlib.util
import json
import pathlib
import threading


spec = importlib.util.spec_from_file_location("mini_bench", pathlib.Path(__file__).with_name("server-mini-bench.py"))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def run(binary, root, port):
    env = bench.environment(root, port)
    env["OPENCODE_DIRECT_TRACE"] = "1"
    clients = []
    endpoint = None
    try:
        result = bench.subprocess.run([binary, "server", "start"], env=env, cwd=env["PWD"], capture_output=True, timeout=45)
        (root / "server-start.txt").write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(result.stderr.decode())
        endpoint = json.loads((root / "daemon/server.json").read_text())
        endpoint = bench.api(endpoint, env, "/__daemon/listen", {})

        def attach(name, extra=()):
            client = bench.Terminal(binary, ["attach", endpoint["url"], "--mini", "--dir", env["PWD"],
                                            "--password", endpoint["password"], *extra], env, root / f"{name}.pty")
            clients.append(client)
            bench.drain_until([client], lambda: client.ready_ms is not None if not extra
                              else b"BUILD" in client.output and b"ctrl+p" in client.output)
            return client

        client = attach("fresh")
        sessions = bench.api(endpoint, env, "/session")
        assert len(sessions) == 1, sessions
        session = sessions[0]["id"]
        client.send("mini-tool\r")
        bench.drain_until([client], lambda: b"Permission required" in client.output)
        requests = bench.api(endpoint, env, "/permission")
        assert any(request["sessionID"] == session for request in requests), requests
        # Exercise the actual footer's default Allow once button.
        client.send("\r")

        def complete():
            history = bench.api(endpoint, env, f"/session/{session}/message")
            tools = [part for message in history for part in message["parts"] if part["type"] == "tool"]
            texts = [part.get("text", "") for message in history if message["info"]["role"] == "assistant"
                     for part in message["parts"] if part["type"] == "text"]
            return (any(part["state"]["status"] == "completed" and "mini-tool-output" in part["state"].get("output", "") for part in tools)
                    and "MINI deterministic response" in texts
                    and b"MINI deterministic response" in client.output)

        bench.drain_until([client], complete, timeout=45)
        assert not bench.api(endpoint, env, "/permission")
        original = bench.api(endpoint, env, f"/session/{session}/message")
        (root / "tool-history.json").write_text(json.dumps(original, indent=2))
        client.close()
        clients.remove(client)

        resumed = attach("resume", ["--session", session])
        bench.drain_until([resumed], lambda: b"MINI deterministic response" in resumed.output)
        resumed.close()
        clients.remove(resumed)
        forked = attach("fork", ["--session", session, "--fork"])
        all_sessions = bench.api(endpoint, env, "/session")
        assert len(all_sessions) == 2, all_sessions
        new = next(item["id"] for item in all_sessions if item["id"] != session)
        assert len(bench.api(endpoint, env, f"/session/{new}/message")) == len(original)
        assert bench.api(endpoint, env, f"/session/{session}/message") == original
        bench.drain_until([forked], lambda: b"MINI deterministic response" in forked.output)
        for name, connection in [("headless-attached", ["--attach", endpoint["url"], "--password", endpoint["password"]]),
                                 ("headless-local", [])]:
            result = bench.subprocess.run([binary, "run", "--dir", env["PWD"], "--model", "mini/mini",
                                           "--format", "json", "--session", new, *connection, "mini-headless"],
                                          env=env, cwd=env["PWD"], capture_output=True, timeout=45)
            (root / f"{name}.stdout").write_bytes(result.stdout)
            (root / f"{name}.stderr").write_bytes(result.stderr)
            assert result.returncode == 0, (name, result.returncode, result.stderr.decode())
            if connection:
                def headless_complete():
                    history = bench.api(endpoint, env, f"/session/{new}/message")
                    return any(part.get("text") == "mini-headless" for message in history
                               if message["info"]["role"] == "user" for part in message["parts"])
                bench.drain_until([forked], headless_complete, timeout=30)
            if not connection:
                assert b"MINI deterministic response" in result.stdout, (name, result.stdout.decode())
        record = {"binary": binary, "sha256": bench.sha(binary), "session": session, "fork": new,
                   "permission_footer": True, "tool_completed": True, "resume_replay": True, "fork_history": True,
                   "headless_attached": True, "headless_local": True,
                   "provider_calls": len(bench.Provider.calls)}
        (root / "result.json").write_text(json.dumps(record, indent=2))
        print(json.dumps(record), flush=True)
    finally:
        for client in clients:
            client.close()
        bench.subprocess.run([binary, "server", "stop"], env=env, cwd=env["PWD"], capture_output=True, timeout=15)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    args = parser.parse_args()
    provider = bench.http.server.ThreadingHTTPServer(("127.0.0.1", 0), bench.Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    try:
        run(args.binary, args.out, provider.server_port)
    finally:
        provider.shutdown()


if __name__ == "__main__":
    main()
