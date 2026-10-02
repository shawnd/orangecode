#!/usr/bin/env python3
"""Cold full-TUI architecture benchmark; stdlib only, Linux /proc + real PTYs.

Requires externally verified frozen hashes. Never builds, installs, warms a
daemon, reads user configuration, or removes fixture/evidence directories.
The shared flock is held for the entire run. Default: three alternating pairs
at N=1,2,4,8,16,32 plus three alternating N=4 held-stream pairs.
"""
import argparse
import base64
import fcntl
import hashlib
import http.client
import http.server
import json
import os
import pathlib
import pty
import re
import select
import signal
import socket
import sqlite3
import statistics
import struct
import subprocess
import termios
import threading
import time
import traceback


EVIDENCE = pathlib.Path('/home/shawn/code/opencode-server-bench-results')
LOCK = '/tmp/opencode/shared-server-bench.lock'
CANDIDATE_HASH = '8a02447126172206a02223fba87032205283f4876fd2860663eb7da6fddb4db3'
MODEL = 'Bench Local Model'
HZ = os.sysconf('SC_CLK_TCK')


def sha(path):
    with open(path, 'rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def save(path, value):
    temporary = path.with_suffix(path.suffix + '.new')
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def headroom():
    values = {line.split(':')[0]: int(line.split()[1])
              for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if ':' in line}
    return {key + '_kib': values[key] for key in ('MemAvailable', 'SwapFree', 'SwapTotal')}


def fleet_budget(report, arm, count):
    """Conservative extrapolation from observed fleet peak; no candidate-only warmup.

    Scaling the entire candidate fleet also scales its one fixed daemon, so this
    intentionally overestimates daemon amortization. Add 25% plus 512 MiB to
    cover unobserved startup peaks and helper churn. Without prior evidence use
    1 GiB per client plus 512 MiB, rather than assuming an optimization gain.
    """
    previous = [run for run in report['runs'] if run['arm'] == arm and run.get('success')
                and not run.get('errors') and run['count'] <= count and run.get('samples')]
    previous = sorted(previous, key=lambda run: run['count'], reverse=True)
    same_count = [run for run in previous if run['count'] == previous[0]['count']] if previous else []
    peak = max((sample['total']['pss_kib'] for run in same_count for sample in run['samples']), default=0)
    estimate = peak * count / same_count[0]['count'] * 1.25 + 512 * 1024 if peak else (count * 1024 + 512) * 1024
    available = headroom()
    return {'estimated_peak_pss_kib': estimate, 'headroom_before': available,
            'required_remaining_kib': 8 * 1024 * 1024,
            'estimated_remaining_kib': available['MemAvailable_kib'] - estimate,
            'safe': available['MemAvailable_kib'] - estimate >= 8 * 1024 * 1024,
            'source_runs': [run['root'] for run in same_count],
            'policy': 'observed max fleet PSS scaled linearly +25% +512MiB; else 1GiB/client +512MiB'}


def proc(pid):
    path = pathlib.Path(f'/proc/{pid}')
    fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'start_ticks': int(fields[19]), 'ppid': int(fields[1]),
            'state': fields[0], 'cpu_ms': (int(fields[11]) + int(fields[12])) * 1000 / HZ,
            'reaped_children_cpu_ms': (int(fields[13]) + int(fields[14])) * 1000 / HZ,
            'command': (path / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')}


def descendants(seeds):
    """Walk only owned process task/children files, never the global process table."""
    found = set(seeds)
    pending = list(seeds)
    while pending:
        pid = pending.pop()
        for path in pathlib.Path(f'/proc/{pid}/task').glob('*/children'):
            try:
                children = [int(value) for value in path.read_text().split()]
            except (FileNotFoundError, ProcessLookupError):
                continue
            for child in children:
                if child not in found:
                    found.add(child)
                    pending.append(child)
    return found


def plain(data):
    text = data.decode(errors='replace')
    text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)


class Terminal:
    def __init__(self, binary, project, env, root, index):
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        # start_new_session avoids unsafe preexec_fn with the local provider thread.
        self.start = time.monotonic()
        self.process = subprocess.Popen([binary, str(project)], cwd=project, env=env,
                                        stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.output = bytearray()
        self.log = open(root / f'client-{index}.pty', 'ab', buffering=0)
        self.events = open(root / f'client-{index}-pty-events.jsonl', 'a', buffering=1)
        self.queries = b''
        self.paint_ms = None
        self.backend_ready_ms = None
        self.ready_ms = None
        self.state = pathlib.Path(env['XDG_STATE_HOME']) / 'opencode/startup-presentation.json'

    def drain(self):
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            return
        if not data:
            return
        offset = len(self.output)
        self.output.extend(data)
        self.log.write(data)
        self.events.write(json.dumps({'elapsed_ms': (time.monotonic() - self.start) * 1000,
                                     'offset': offset, 'bytes': len(data)}) + '\n')
        # Retain a tail so a query split across reads gets exactly one reply.
        combined = self.queries + data
        for query, reply in [(b'\x1b[6n', b'\x1b[1;1R'),
                             (b'\x1b]10;?', b'\x1b]10;rgb:dddd/dddd/dddd\x07'),
                             (b'\x1b]11;?', b'\x1b]11;rgb:1111/1111/1111\x07'),
                             (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[>c', b'\x1b[>0;0;0c')]:
            for match in re.finditer(re.escape(query), combined):
                if match.end() > len(self.queries):
                    os.write(self.fd, reply)
        self.queries = combined[-16:]
        if self.paint_ms is None and b'Ask anything' in self.output:
            self.paint_ms = (time.monotonic() - self.start) * 1000

    def usable(self):
        try:
            value = json.loads(self.state.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None
        selection = value.get('selection', {})
        models = value.get('controls', {}).get('models', [])
        if selection.get('providerID') != 'bench' or selection.get('modelID') != 'bench-model':
            return None
        if not any(model.get('id') == 'bench-model' for model in models):
            return None
        if self.backend_ready_ms is None:
            self.backend_ready_ms = (time.monotonic() - self.start) * 1000
        if MODEL not in plain(self.output):
            return None
        return value


class Provider(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers['Content-Length']))
        body = json.loads(raw)
        # Runner main calls carry the session header and materialized tools;
        # ancillary/title requests are answered immediately and never held.
        user = json.dumps([m for m in body.get('messages', []) if m.get('role') == 'user'])
        match = re.search(r'BENCH_CLIENT_(\d+)', user)
        main = bool(self.headers.get('X-Session-Id') and body.get('tools') and match)
        sid = self.headers.get('X-Session-Id')
        client = int(match.group(1)) if match else None
        hit = {'event': 'request', 'time': time.monotonic(), 'path': self.path,
               'session': sid, 'client': client, 'main': main, 'request_bytes': len(raw),
               'stream': body.get('stream'), 'headers': dict(self.headers), 'body': body}
        self.server.record(hit)
        marker = f'BENCH_DONE_{client}' if main else 'Benchmark title'
        response_bytes = 0
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()

            def chunk(delta, finish=None):
                nonlocal response_bytes
                value = {'id': f'bench-{client}', 'object': 'chat.completion.chunk', 'created': 1,
                         'model': 'bench-model', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                data = ('data: ' + json.dumps(value) + '\n\n').encode()
                self.wfile.write(data)
                self.wfile.flush()
                response_bytes += len(data)

            chunk({'role': 'assistant'})
            if main:
                chunk({'content': f'BENCH_ACTIVE_{client} '})
                with self.server.condition:
                    if sid in self.server.inflight:
                        raise RuntimeError('duplicate main call for session')
                    self.server.inflight[sid] = client
                    self.server.condition.notify_all()
                self.server.record({'event': 'held', 'session': sid, 'client': client,
                                    'time': time.monotonic(), 'response_bytes': response_bytes})
                if not self.server.gate.wait(120):
                    raise TimeoutError('stream release gate')
            chunk({'content': marker})
            chunk({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
            response_bytes += len(b'data: [DONE]\n\n')
            self.server.record({'event': 'completed', 'session': sid, 'client': client, 'main': main,
                                'marker': marker, 'response_bytes': response_bytes, 'time': time.monotonic()})
        except Exception as error:
            self.server.record({'event': 'error', 'session': sid, 'client': client, 'error': repr(error)})
        finally:
            self.close_connection = True
            with self.server.condition:
                self.server.inflight.pop(sid, None)
                self.server.condition.notify_all()


class Run:
    def __init__(self, args, arm, count, repeat, phase, report):
        self.args = args
        self.arm = arm
        self.binary = getattr(args, arm)
        self.expected = getattr(args, arm + '_sha256')
        # Keep the disk-backed daemon Unix socket below Linux sun_path limits.
        self.root = args.out / f'{phase[0]}{count}-r{repeat}-{arm[0]}'
        self.root.mkdir()
        for name in ('home', 'config', 'data', 'cache', 'runtime', 'tmp', 'project', 'states'):
            (self.root / name).mkdir(mode=0o700)
        self.children = []
        self.known = {}
        self.cpu_seen = {}
        self.daemon = None
        self.endpoint = None
        self.last_headroom_check = 0
        self.report = report
        self.result = {'arm': arm, 'count': count, 'repeat': repeat, 'phase': phase,
                       'root': str(self.root), 'samples': [], 'readiness': [], 'errors': []}
        report['runs'].append(self.result)
        self.provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        self.provider.daemon_threads = True
        self.provider.condition = threading.Condition()
        self.provider.gate = threading.Event()
        self.provider.inflight = {}
        self.provider.hits = []
        self.provider.log = open(self.root / 'provider.jsonl', 'a', buffering=1)

        def record(value):
            with self.provider.condition:
                self.provider.hits.append(value)
                self.provider.log.write(json.dumps(value) + '\n')
                self.provider.condition.notify_all()

        self.provider.record = record
        url = f'http://127.0.0.1:{self.provider.server_port}/v1'
        model = {'name': MODEL, 'limit': {'context': 1000000, 'output': 10000},
                 'cost': {'input': 0, 'output': 0}, 'tool_call': True}
        legacy = {'formatter': False, 'lsp': False, 'autoupdate': False,
                  'model': 'bench/bench-model', 'small_model': 'bench/bench-model',
                  'enabled_providers': ['bench'], 'plugin': [],
                  'provider': {'bench': {'name': 'Bench Local Provider', 'env': [],
                                        'npm': '@ai-sdk/openai-compatible',
                                        'models': {'bench-model': model},
                                        'options': {'apiKey': 'local-no-spend', 'baseURL': url}}}}
        current = {'formatter': False, 'lsp': False, 'autoupdate': False, 'model': 'bench/bench-model',
                   'providers': {'bench': {'name': 'Bench Local Provider',
                     'api': {'type': 'aisdk', 'package': '@ai-sdk/openai-compatible', 'url': url},
                     'request': {'body': {'apiKey': 'local-no-spend'}},
                     'models': {'bench-model': {'name': MODEL, 'disabled': False,
                       'api': {'id': 'bench-model', 'type': 'aisdk', 'package': '@ai-sdk/openai-compatible', 'url': url},
                       'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']},
                       'limit': model['limit'], 'cost': model['cost']}}}}}
        (self.root / 'project/opencode.json').write_text(json.dumps(current))
        (self.root / 'catalog.json').write_text('{}')
        save(self.root / 'legacy-config.json', legacy)
        self.env = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color',
                    'COLORTERM': 'truecolor', 'HOME': str(self.root / 'home'),
                    'PWD': str(self.root / 'project'), 'TMPDIR': str(self.root / 'tmp'),
                    'TMP': str(self.root / 'tmp'), 'TEMP': str(self.root / 'tmp'),
                    'XDG_RUNTIME_DIR': str(self.root / 'runtime'),
                    'OPENCODE_DAEMON_DIR': str(self.root / 'daemon'),
                    'OPENCODE_DB': str(self.root / 'data/bench.sqlite'),
                    'OPENCODE_TEST_HOME': str(self.root / 'home'),
                    'OPENCODE_CONFIG_CONTENT': json.dumps(legacy),
                    'OPENCODE_MODELS_PATH': str(self.root / 'catalog.json'),
                    'DO_NOT_TRACK': '1', 'OTEL_SDK_DISABLED': 'true', 'OPENCODE_PURE': '1',
                    **{f'XDG_{key}_HOME': str(self.root / value) for key, value in
                       [('CONFIG', 'config'), ('DATA', 'data'), ('CACHE', 'cache')]},
                    **{f'OPENCODE_DISABLE_{key}': '1' for key in
                       ['AUTOUPDATE', 'MODELS_FETCH', 'DEFAULT_PLUGINS', 'EXTERNAL_SKILLS',
                        'CLAUDE_CODE', 'LSP_DOWNLOAD', 'SHARE']}}
        save(self.root / 'environment.json', self.env)
        threading.Thread(target=self.provider.serve_forever, daemon=True).start()
        self.persist()

    def persist(self):
        save(self.root / 'run.json', self.result)
        save(self.args.out / 'results.json', self.report)

    def pump(self, seconds, check=True):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if check and self.result['count'] >= 8 and time.monotonic() - self.last_headroom_check >= 1:
                self.last_headroom_check = time.monotonic()
                if headroom()['MemAvailable_kib'] < 8 * 1024 * 1024:
                    raise RuntimeError('STOP: actual MemAvailable below 8GiB during PTY readiness/settling')
            ready = select.select([c.fd for c in self.children], [], [],
                                  min(.05, max(0, deadline - time.monotonic())))[0]
            for child in self.children:
                if child.fd in ready:
                    child.drain()
                if check and child.process.poll() is not None:
                    raise RuntimeError(f'TUI {child.process.pid} exited {child.process.returncode}')

    def until(self, condition, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(.05)
            value = condition()
            if value:
                return value
        raise TimeoutError('readiness/flow deadline; inspect incremental PTY/provider evidence')

    def request(self, route):
        headers = {'Authorization': 'Basic ' + base64.b64encode(
            ('opencode:' + self.endpoint['password']).encode()).decode(),
            'x-opencode-directory': self.env['PWD']}
        connection = http.client.HTTPConnection('127.0.0.1', timeout=10)
        if self.endpoint.get('socket'):
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(10)
            connection.sock.connect(self.endpoint['socket'])
        else:
            from urllib.parse import urlsplit
            address = urlsplit(self.endpoint['url'])
            connection = http.client.HTTPConnection(address.hostname, address.port, timeout=10)
        try:
            connection.request('GET', route, headers=headers)
            response = connection.getresponse()
            data = response.read()
            if response.status != 200:
                raise RuntimeError(f'{route}: HTTP {response.status} {data!r}')
            return json.loads(data)
        finally:
            connection.close()

    def topology(self, index):
        path = self.root / 'daemon/server.json'
        if self.arm == 'baseline':
            if path.exists():
                raise RuntimeError('baseline unexpectedly created a shared daemon')
            self.result.setdefault('topology', []).append({'client': index, 'metadata_absent': True})
            return
        self.endpoint = json.loads(path.read_text())
        status = self.request('/__daemon/status')
        if self.daemon is not None and self.daemon != status['pid']:
            raise RuntimeError('candidate clients did not share one daemon PID')
        self.daemon = status['pid']
        if b'OPENCODE_DAEMON_DIR=' + str(self.root / 'daemon').encode() not in pathlib.Path(
                f'/proc/{self.daemon}/environ').read_bytes().split(b'\0'):
            raise RuntimeError('daemon is outside owned fixture')
        image = os.stat(f'/proc/{self.daemon}/exe')
        frozen = os.stat(self.binary)
        if (image.st_dev, image.st_ino) != (frozen.st_dev, frozen.st_ino):
            raise RuntimeError('unexpected daemon binary')
        self.known[self.daemon] = proc(self.daemon)['start_ticks']
        self.result.setdefault('topology', []).append({'client': index, 'status': status,
                                                       'endpoint_file': str(path)})

    def sample(self, phase, memory=True, enforce_headroom=True):
        seeds = {c.process.pid for c in self.children}
        if self.daemon:
            seeds.add(self.daemon)
        rows = []
        for pid in sorted(descendants(seeds)):
            try:
                value = proc(pid)
                if value['state'] == 'Z':
                    continue
                self.known.setdefault(pid, value['start_ticks'])
                if self.known[pid] != value['start_ticks']:
                    raise RuntimeError('owned PID identity changed')
                path = pathlib.Path(f'/proc/{pid}')
                value['role'] = ('daemon' if pid == self.daemon else
                                 ('tui+backend-worker' if self.arm == 'baseline' else 'tui')
                                 if pid in seeds else 'helper-descendant')
                value['exe'] = os.readlink(path / 'exe')
                value['threads'] = [{ 'tid': int(task.name), 'name': (task / 'comm').read_text().strip()}
                                    for task in (path / 'task').iterdir()]
                if memory:
                    values = {line.split(':')[0]: int(line.split()[1]) for line in
                              (path / 'smaps_rollup').read_text().splitlines()
                              if ':' in line and len(line.split()) > 1 and line.split()[1].isdigit()}
                    value.update({key.lower() + '_kib': values.get(key, 0) for key in ('Pss', 'Rss', 'SwapPss')})
                self.cpu_seen[(pid, value['start_ticks'])] = value['cpu_ms']
                rows.append(value)
            except (FileNotFoundError, ProcessLookupError):
                continue
        snapshot = {'phase': phase, 'time': time.monotonic(), 'processes': rows,
                    'headroom': headroom(), 'cpu_ms': sum(self.cpu_seen.values()),
                    'cpu_accounting': 'sum observed own utime+stime by unique PID/starttime; exited helper lower bound',
                    'total': {key: sum(row.get(key, 0) for row in rows)
                              for key in ('pss_kib', 'rss_kib', 'swappss_kib')}}
        self.result['samples'].append(snapshot)
        self.persist()
        if enforce_headroom and self.result['count'] >= 8 and snapshot['headroom']['MemAvailable_kib'] < 8 * 1024 * 1024:
            raise RuntimeError('STOP: large-fleet actual MemAvailable below 8 GiB')
        return snapshot

    def samples(self, phase):
        rows = []
        for index in range(self.args.samples):
            rows.append(self.sample(phase))
            if index + 1 < self.args.samples:
                # Deliberate equal workload observation intervals, with PTY draining.
                self.pump(self.args.interval)
        summary = {key: statistics.median(row['total'][key] for row in rows)
                   for key in ('pss_kib', 'rss_kib', 'swappss_kib')}
        summary.update({'cpu_ms': rows[-1]['cpu_ms'] - rows[0]['cpu_ms'],
                        'elapsed_s': rows[-1]['time'] - rows[0]['time']})
        self.result.setdefault('medians', {})[phase] = summary
        self.persist()
        return summary

    def start(self):
        self.result['headroom_before'] = headroom()
        if self.result['count'] >= 8 and self.result['headroom_before']['MemAvailable_kib'] < 8 * 1024 * 1024:
            raise RuntimeError('STOP: large-fleet real memory headroom below 8 GiB')
        if sha(self.binary) != self.expected:
            raise RuntimeError('frozen image hash mismatch before launch')
        self.result['start_time'] = time.monotonic()
        for index in range(self.result['count']):
            if self.result['count'] >= 8 and headroom()['MemAvailable_kib'] < 8 * 1024 * 1024:
                raise RuntimeError('STOP: real memory headroom below 8 GiB before next client')
            state = self.root / 'states' / str(index)
            state.mkdir()
            env = {**self.env, 'XDG_STATE_HOME': str(state)}
            child = Terminal(self.binary, self.root / 'project', env, self.root, index)
            self.children.append(child)
            self.known[child.process.pid] = proc(child.process.pid)['start_ticks']
            image = os.stat(f'/proc/{child.process.pid}/exe')
            frozen = os.stat(self.binary)
            if (image.st_dev, image.st_ino) != (frozen.st_dev, frozen.st_ino):
                raise RuntimeError('unexpected TUI binary')
            cached = self.until(child.usable)
            child.ready_ms = (time.monotonic() - child.start) * 1000
            save(self.root / f'client-{index}-ready-cache.json', cached)
            self.result['readiness'].append({'client': index, 'pid': child.process.pid,
                'paint_ms': child.paint_ms, 'backend_ready_ms': child.backend_ready_ms,
                'usable_ms': child.ready_ms, 'pty_bytes_at_usable': len(child.output),
                'gate': 'fresh per-client sync.ready/model.ready selection+catalog cache AND visibly rendered configured model'})
            self.topology(index)
            self.sample(f'client-{index}-usable', memory=False)
        self.result['fleet_usable_elapsed_s'] = time.monotonic() - self.result['start_time']
        ready = self.sample('all-usable')
        self.result['startup_cpu_ms'] = ready['cpu_ms']
        # Equal fixed settling measures the architecture after deliberate idle time.
        self.pump(self.args.settle)
        settled = self.sample('settled-start')
        self.result['post_readiness_cpu_ms'] = settled['cpu_ms'] - ready['cpu_ms']
        self.result['settle_elapsed_s'] = settled['time'] - ready['time']

    def persisted(self, sessions, markers):
        path = self.root / 'data/bench.sqlite'
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2) as db:
            rows = [dict(zip(('id', 'session_id', 'type', 'seq', 'data'), row)) for row in db.execute(
                'select id,session_id,type,seq,data from session_message order by session_id,seq')]
        self.result['persisted_history'] = rows
        self.persist()
        return all(any(row['session_id'] == sid and marker in row['data'] for row in rows)
                   for sid, marker in zip(sessions, markers))

    def active(self):
        beginning = self.sample('active-before', memory=False)
        started = time.monotonic()
        for index, child in enumerate(self.children):
            os.write(child.fd, f'BENCH_CLIENT_{index} Reply briefly with deterministic text.'.encode())
        self.pump(.5)
        for child in self.children:
            os.write(child.fd, b'\r')

        def held():
            with self.provider.condition:
                return len(self.provider.inflight) == 4 and set(self.provider.inflight.values()) == set(range(4))

        self.until(held)
        mains = [hit for hit in self.provider.hits if hit.get('main') and hit['event'] == 'request']
        if len(mains) != 4 or len({hit['session'] for hit in mains}) != 4:
            raise RuntimeError('expected exactly four unique main calls/sessions')
        self.until(lambda: all(f'BENCH_ACTIVE_{i}' in plain(c.output) for i, c in enumerate(self.children)))
        self.result['active'] = {'concurrency': dict(self.provider.inflight), 'main_calls': len(mains),
                                 'time_to_four_held_s': time.monotonic() - started, 'provider_spend': 0}
        self.pump(3)
        self.samples('text-active')
        if not held():
            raise RuntimeError('streams not simultaneously held throughout measurement')
        end = self.sample('active-end', memory=False)
        self.result['active'].update({'cpu_ms': end['cpu_ms'] - beginning['cpu_ms'],
                                     'held_elapsed_s': time.monotonic() - started,
                                     'request_bytes': sum(hit['request_bytes'] for hit in mains)})
        self.provider.gate.set()
        markers = [f'BENCH_DONE_{index}' for index in range(4)]
        self.until(lambda: all(marker in plain(child.output) for marker, child in zip(markers, self.children)))
        sessions = [next(hit['session'] for hit in mains if hit['client'] == index) for index in range(4)]
        self.until(lambda: self.persisted(sessions, markers), timeout=30)
        self.until(lambda: sum(hit['event'] == 'completed' and hit.get('main', False)
                               for hit in self.provider.hits) == 4)
        self.result['active'].update({'visible_and_persisted_completion': True,
            'completion_elapsed_s': time.monotonic() - started,
            'response_bytes': sum(hit.get('response_bytes', 0) for hit in self.provider.hits
                                  if hit['event'] == 'completed'),
            'ancillary_calls': sum(hit['event'] == 'request' and not hit.get('main') for hit in self.provider.hits)})
        self.pump(self.args.settle)
        self.samples('text-completed-settled')

    def cleanup(self):
        self.provider.gate.set()
        # A failed readiness gate may precede discovery of a detached daemon.
        path = self.root / 'daemon/server.json'
        try:
            if self.daemon is None and path.exists():
                self.topology(len(self.children) - 1)
            self.sample('cleanup-before', memory=False, enforce_headroom=False)
        except Exception as error:
            self.result['errors'].append({'stage': 'cleanup-discovery', 'error': repr(error)})
            for pid in descendants({child.process.pid for child in self.children}):
                try:
                    self.known.setdefault(pid, proc(pid)['start_ticks'])
                except (FileNotFoundError, ProcessLookupError):
                    pass
        live = {}
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid, identity in self.known.items():
                try:
                    value = proc(pid)
                    if value['start_ticks'] == identity and value['state'] != 'Z':
                        os.kill(pid, sig)
                except (FileNotFoundError, ProcessLookupError):
                    pass
            for child in self.children:
                try:
                    child.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            self.pump(.5, check=False)
        for pid, identity in self.known.items():
            try:
                value = proc(pid)
                if value['start_ticks'] == identity and value['state'] != 'Z':
                    live[pid] = value
            except (FileNotFoundError, ProcessLookupError):
                pass
        for child in self.children:
            child.log.close()
            child.events.close()
            os.close(child.fd)
        self.provider.shutdown()
        self.provider.server_close()
        self.provider.log.close()
        self.result['cleanup'] = {'live_owned_pids': live, 'identities': self.known,
                                  'evidence_preserved': True, 'finished': not live}
        self.persist()
        if live:
            raise RuntimeError(f'owned benchmark processes remain alive: {live}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--baseline-sha256', required=True, help='parent-verified current shawnd hash')
    parser.add_argument('--candidate-sha256', default=CANDIDATE_HASH)
    parser.add_argument('--out', type=pathlib.Path, required=True, help='NEW directory under evidence root')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--counts', nargs='+', type=int, default=[1, 2, 4, 8, 16, 32])
    parser.add_argument('--settle', type=float, default=12)
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--interval', type=float, default=2)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--idle-only', action='store_true')
    modes.add_argument('--active-only', action='store_true')
    args = parser.parse_args()
    args.out = args.out.resolve()
    if not args.out.is_relative_to(EVIDENCE) or args.out == EVIDENCE or args.out.is_relative_to(EVIDENCE / 'artifacts'):
        parser.error('--out must be an owned NEW directory under evidence root, outside artifacts')
    if args.out.exists() or not args.out.parent.is_dir():
        parser.error('--out must be new and its parent must already exist')
    if len(str(args.out / f'i32-r{args.repeats}-c/daemon/server.sock').encode()) >= 104:
        parser.error('--out path too long for isolated daemon Unix socket; use a short output basename')
    if args.repeats < 1 or args.samples < 2 or args.interval <= 0 or args.settle < 0:
        parser.error('invalid repeats/sampling/settling')
    if any(n not in (1, 2, 4, 8, 16, 32) for n in args.counts) or args.counts != sorted(set(args.counts)):
        parser.error('counts must be unique ascending values from 1,2,4,8,16,32')
    for arm in ('baseline', 'candidate'):
        if not re.fullmatch('[0-9a-f]{64}', getattr(args, arm + '_sha256')):
            parser.error(f'invalid {arm} verified hash')
        setattr(args, arm, str(pathlib.Path(getattr(args, arm)).resolve(strict=True)))
        if sha(getattr(args, arm)) != getattr(args, arm + '_sha256'):
            parser.error(f'{arm} frozen binary hash does not match verified hash')
    args.out.mkdir(mode=0o700)
    report = {'root': str(args.out), 'runs': [], 'binaries': {}, 'errors': [],
              'method': {'launch': '[exact binary, isolated project] full default CLI; no prelaunch',
                         'declared_source_revisions': {'baseline': 'shawnd 7bd0148203', 'candidate': 'shared-server synced 7e57e73e42'},
                         'harness_sha256': sha(__file__),
                         'image_identity': 'verified frozen SHA256 before/after; live TUI/daemon exe device+inode matches frozen image',
                         'geometry': '120x40 xterm-256color', 'repeats': args.repeats, 'counts': args.counts,
                         'settle_s': args.settle, 'samples': args.samples, 'interval_s': args.interval,
                         'accounting': 'unique renderer+in-process Worker+daemon+helper descendants; PSS primary, RSS/SwapPSS secondary',
                         'cpu_limitation': 'exited unreaped/unobserved helper CPU can be missed; no forced GC or tracing',
                         'active': 'N4 four concurrent main text streams; no optional read-tool round',
                         'fixture_history': 'empty per independent run; fresh per-client presentation/editor state',
                         'lock': LOCK, 'provider_spend': 0}}
    save(args.out / 'results.json', report)
    failed = False
    with open(LOCK, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        report['lock_acquired_at'] = time.time()
        try:
            for arm in ('baseline', 'candidate'):
                report['binaries'][arm] = {'path': getattr(args, arm),
                    'sha256_before': sha(getattr(args, arm)), 'expected_sha256': getattr(args, arm + '_sha256')}
            save(args.out / 'results.json', report)
            plan = ([] if args.active_only else [('idle', n) for n in args.counts])
            if not args.idle_only:
                plan.append(('active', 4))
            for phase, count in plan:
                for repeat in range(1, args.repeats + 1):
                    for arm in (('baseline', 'candidate') if repeat % 2 else ('candidate', 'baseline')):
                        budget = fleet_budget(report, arm, count) if count >= 8 else None
                        if budget and not budget['safe']:
                            skipped = {'arm': arm, 'count': count, 'repeat': repeat, 'phase': phase,
                                       'root': str(args.out / f'{phase[0]}{count}-r{repeat}-{arm[0]}'),
                                       'skipped': 'estimated fleet peak would leave less than 8GiB available',
                                       'memory_budget': budget, 'errors': [], 'samples': []}
                            report['runs'].append(skipped)
                            save(args.out / 'results.json', report)
                            print(json.dumps(skipped), flush=True)
                            continue
                        run = Run(args, arm, count, repeat, phase, report)
                        run.result['memory_budget'] = budget
                        try:
                            # Version subprocess is isolated too; before cold architecture timing.
                            env = {**run.env, 'XDG_STATE_HOME': str(run.root / 'states')}
                            version = subprocess.run([run.binary, '--version'], env=env, cwd=run.root,
                                                     capture_output=True, text=True, timeout=20)
                            save(run.root / 'version.json', {'stdout': version.stdout, 'stderr': version.stderr,
                                                            'returncode': version.returncode})
                            if version.returncode:
                                raise RuntimeError('version command failed')
                            report['binaries'][arm]['version'] = version.stdout.strip()
                            run.start()
                            run.samples('idle')
                            if phase == 'active':
                                run.active()
                            run.result['success'] = True
                        except BaseException as error:
                            run.result['errors'].append({'error': repr(error), 'traceback': traceback.format_exc()})
                            failed = True
                            raise
                        finally:
                            try:
                                run.cleanup()
                            except BaseException as error:
                                run.result['errors'].append({'stage': 'cleanup', 'error': repr(error),
                                                             'traceback': traceback.format_exc()})
                                failed = True
                                run.persist()
                            run.result['provider_calls'] = run.provider.hits
                            run.result['sha256_after'] = sha(run.binary)
                            if run.result['sha256_after'] != run.expected:
                                raise RuntimeError('frozen binary changed during run')
                            run.persist()
                            print(json.dumps({'run': str(run.root), 'success': run.result.get('success', False),
                                              'errors': run.result['errors'], 'medians': run.result.get('medians')}), flush=True)
                        if failed:
                            raise RuntimeError('measurement/cleanup failed; stopping matrix')
            report['finished'] = True
        except BaseException as error:
            failed = True
            report['errors'].append({'error': repr(error), 'traceback': traceback.format_exc()})
        finally:
            for arm in ('baseline', 'candidate'):
                report['binaries'].setdefault(arm, {})['sha256_after'] = sha(getattr(args, arm))
            report['lock_released_at'] = time.time()
            save(args.out / 'results.json', report)
    print(str(args.out / 'results.json'), flush=True)
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
