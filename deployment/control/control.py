#!/usr/bin/env python3
"""LAN Stremio control plane; root-owned Unix socket, no public listener.

Only constant Docker commands and validated, fixed operations are accepted.
The addon authenticates admins before proxying to this socket.
"""
import copy
import datetime as dt
import http.server
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import signal
import secrets
import socketserver
import subprocess
import threading
import time
import urllib.request

VERSION = '0.8.7'
HASH = re.compile(r'^[0-9a-f]{40}$')
STOP = threading.Event()
ENGINE_JS = """(async()=>{const out={};for(const [k,url] of [['manifest','http://127.0.0.1:3000/manifest.json'],['limiter','http://127.0.0.1:8080/playback-limiter'],['torrents','http://127.0.0.1:8080/torrents']]){try{const r=await fetch(url,{signal:AbortSignal.timeout(2500)});out[k]={status:r.status,data:await r.json()};}catch(e){out[k]={status:0,error:e.name};}}console.log(JSON.stringify(out));})()"""

def command(args, timeout=12):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('command_failed:' + Path(args[0]).name)
    return result.stdout.strip()

def atomic_json(path, data):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(path)

def capacity(sessions):
    if any(s['quality'] == '4k' for s in sessions):
        return {'mode': '4k', 'freeHD': 0, 'can4K': False, 'message': '4K lejátszás foglalja a szervert. Másik film most nem indítható.'}
    free = max(0, 2 - len(sessions))
    return {'mode': 'hd' if sessions else 'idle', 'freeHD': free, 'can4K': not sessions,
        'message': f'{free}/2 HD hely szabad.' + (' A 4K-hoz minden HD lejátszást le kell állítani.' if sessions else ' Egy 4K film is indítható.')}

def torrent_identity(path):
    """Bounded bencode parser; hashes the original info bytes, never re-encodes."""
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 32 * 1024**2:
        raise ValueError('Unsafe torrent descriptor')
    raw = path.read_bytes()
    position, info_raw = 0, None
    def parse(depth=0):
        nonlocal position, info_raw
        if depth > 64 or position >= len(raw): raise ValueError('Invalid bencode')
        token = raw[position:position+1]
        position += 1
        if token == b'i':
            end = raw.index(b'e', position)
            result = int(raw[position:end]); position = end + 1
            return result
        if token in (b'd', b'l'):
            result = {} if token == b'd' else []
            while position < len(raw) and raw[position:position+1] != b'e':
                if token == b'd':
                    key = parse(depth+1)
                    if not isinstance(key, bytes) or key in result: raise ValueError('Invalid dictionary')
                    start = position
                    result[key] = parse(depth+1)
                    if depth == 0 and key == b'info': info_raw = raw[start:position]
                else: result.append(parse(depth+1))
            if position >= len(raw): raise ValueError('Unterminated bencode')
            position += 1
            return result
        if token.isdigit():
            position -= 1
            end = raw.index(b':', position)
            length = int(raw[position:end]); position = end + 1
            if length < 0 or position + length > len(raw): raise ValueError('Invalid string')
            result = raw[position:position+length]; position += length
            return result
        raise ValueError('Invalid bencode')
    data = parse()
    if position != len(raw) or not isinstance(data, dict) or not info_raw: raise ValueError('Invalid torrent')
    info = data[b'info']
    names = {info[k].decode('utf-8', errors='strict') for k in (b'name', b'name.utf-8') if k in info}
    if not names or any(not n or n in ('.', '..') or any(x in n for x in ('/', '\\', '\x00')) for n in names):
        raise ValueError('Unsafe torrent name')
    return hashlib.sha1(info_raw).hexdigest(), names

class Control:
    def __init__(self, config, clock=time.time, runner=command):
        self.config, self.clock, self.run = config, clock, runner
        self.lock = threading.RLock()
        self.mutation = threading.Lock()
        self.snapshot = {'version': VERSION, 'ready': False, 'message': 'Állapot lekérése…'}
        self.history, self.ledger = {}, {}
        self.events = []
        self.started = clock()
        self.last_saved = 0
        self.failures = 0
        self.restarts = []
        self.mounted = False
        self.last_cleanup = 0
        self.alert_codes = set()
        self.plans = {}
        self.pending_cleanup = []
        self.pending_auto = False
        self.previous_active = set()
        self.state_error = False

    @property
    def root(self):
        return Path(self.config['mount']) / 'stremio-ncore'

    def valid_mount(self):
        try:
            return self.run(['findmnt', '-rn', '--mountpoint', self.config['mount'], '-o', 'UUID,OPTIONS'], 3).split()[0] == self.config['uuid'] and 'rw' in self.run(['findmnt', '-rn', '--mountpoint', self.config['mount'], '-o', 'OPTIONS'], 3).split(',')
        except (RuntimeError, subprocess.SubprocessError, IndexError):
            return False

    def load(self):
        if not self.valid_mount():
            return
        path = self.root / 'control/state.json'
        if path.exists():
            try:
                data = json.loads(path.read_text())
                assert isinstance(data['torrents'], dict) and isinstance(data['restarts'], list)
                for key, item in data['torrents'].items():
                    assert HASH.fullmatch(key) and type(item['keep']) is bool
                    assert all(type(item[k]) in (int, float) for k in ('firstSeen', 'lastUsed'))
                assert all(type(t) in (int, float) for t in data['restarts'])
                self.ledger = data['torrents']
                self.restarts = data['restarts']
            except (ValueError, OSError, KeyError, TypeError, AssertionError):
                self.state_error = True
                self.config['cleanup']['enabled'] = False
                self.config['recovery']['enabled'] = False
                self.event('state_corrupt', 'A mentett megőrzési/helyreállítási állapot nem olvasható. Takarítás és automatikus újraindítás letiltva; az eredeti állapotfájl megmaradt.')

    def save(self, force=False):
        if self.state_error or not self.valid_mount() or (not force and self.clock() - self.last_saved < 1800):
            return False
        directory = self.root / 'control'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            atomic_json(directory / 'state.json', {'torrents': self.ledger, 'restarts': self.restarts})
        except OSError:
            self.state_error = True
            self.config['cleanup']['enabled'] = False
            self.config['recovery']['enabled'] = False
            raise
        self.last_saved = self.clock()
        return True

    def event(self, code, message):
        entry = {'time': self.clock(), 'code': code, 'message': message}
        with self.lock:
            self.events.append(entry)
            self.events = self.events[-80:]
        if self.valid_mount():
            directory = self.root / 'control'
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = directory / 'events.jsonl'
            if path.exists() and path.stat().st_size > 2 * 1024**2:
                path.replace(directory / 'events.previous.jsonl')
            with path.open('a') as stream:
                stream.write(json.dumps(entry, ensure_ascii=False) + '\n')

    def inspect(self):
        raw = json.loads(self.run(['docker', 'inspect', '--format', '{"state":{{json .State}},"restarts":{{.RestartCount}}}', self.config['container']], 5))
        return {'running': raw['state']['Running'], 'status': raw['state']['Status'],
            'restarts': raw['restarts'], 'startedAt': raw['state']['StartedAt'], 'oom': raw['state']['OOMKilled'], 'pid': raw['state']['Pid']}

    def engine(self):
        result = json.loads(self.run(['docker', 'exec', self.config['container'], 'node', '-e', ENGINE_JS], 12))
        # Verify the actual published LAN address too, not just container loopback.
        try:
            with urllib.request.urlopen(self.config['web_url'] + '/manifest.json', timeout=3) as response:
                result['manifest'] = {'status': response.status, 'data': json.load(response)}
        except Exception as error:
            result['manifest'] = {'status': 0, 'error': type(error).__name__}
        return result

    def storage_error(self):
        try:
            source = self.run(['findmnt', '-rn', '--mountpoint', self.config['mount'], '-o', 'SOURCE'], 3)
            device = re.sub(r'\d+$', '', Path(source).name)
            if not device or not re.fullmatch(r'[a-z0-9]+', device): return False
            lines = self.run(['journalctl', '-k', '--since', '2 minutes ago', '--lines', '100', '--no-pager'], 4)
            return any(re.search(r'I/O error|device offline|Buffer I/O|exfat.*error', line, re.I) and
                (device in line or 'exfat' in line.lower()) for line in lines.splitlines())
        except (RuntimeError, subprocess.SubprocessError):
            return False

    def tcp(self, pid):
        result = self.run(['nsenter', '-t', str(pid), '-n', 'ss', '-tin', 'sport', '=', ':3443'], 4)
        peers, current = {}, None
        for line in result.splitlines():
            if line.startswith('ESTAB'):
                match = re.search(r'(?:\[::ffff:)?(192\.168\.1\.\d+)\]?:\d+', line)
                current = match[1] if match else None
                if current:
                    peers[current] = {'sendQueue': int(line.split()[2])}
            elif current:
                for label in ['bytes_acked', 'bytes_sent', 'lastack', 'retrans', 'lost']:
                    match = re.search(r'\b' + label + r':(\d+)', line)
                    if match:
                        peers[current][label] = int(match[1])
        return peers

    def poll(self):
        now = self.clock()
        mounted = self.valid_mount()
        alerts, torrents, sessions, engine, state = [], [], [], {}, {}
        if self.state_error:
            alerts.append({'code':'state_corrupt','level':'error','message':'A mentett megőrzési állapot sérült. A megfigyelés működik, de takarítás és automatikus újraindítás nincs.'})
        if not mounted:
            alerts.append({'code': 'hdd_missing', 'level': 'error', 'message': 'A megfelelő HDD nincs írhatóan csatlakoztatva. Helyreállítás és takarítás letiltva.'})
        try:
            state = self.inspect()
            if state['running'] and mounted:
                engine = self.engine()
                healthy = all(engine.get(k, {}).get('status') == 200 for k in ('manifest', 'limiter', 'torrents'))
                torrents = engine.get('torrents', {}).get('data', []) if engine.get('torrents', {}).get('status') == 200 else []
                sessions = engine.get('limiter', {}).get('data', {}).get('sessions', []) if engine.get('limiter', {}).get('status') == 200 else []
            else:
                healthy = False
        except (RuntimeError, ValueError, subprocess.SubprocessError):
            healthy = False
        active = {s['infoHash'] for s in sessions}
        with self.mutation:
            for torrent in torrents:
                key = torrent['infoHash']
                item = self.ledger.setdefault(key, {'firstSeen': now, 'lastUsed': now, 'keep': False})
                if key in active:
                    item['lastUsed'] = now
                old = self.history.get(key)
                elapsed = now - old['time'] if old else 0
                torrent['downloadRate'] = max(0, torrent['downloaded'] - old['downloaded']) / elapsed if elapsed > 0 else 0
                torrent['uploadRate'] = max(0, torrent['uploaded'] - old['uploaded']) / elapsed if elapsed > 0 else 0
                stagnant = now if not old or torrent['downloaded'] != old['downloaded'] else old['stagnant']
                self.history[key] = {'time': now, 'downloaded': torrent['downloaded'], 'uploaded': torrent['uploaded'], 'stagnant': stagnant}
                torrent.update(keep=item['keep'], lastUsed=item['lastUsed'], firstSeen=item['firstSeen'], active=key in active)
            self.save(force=active != self.previous_active)
            self.previous_active = active
        try:
            peers = self.tcp(state['pid']) if healthy else {}
        except (RuntimeError, subprocess.SubprocessError):
            peers = {}
        for session in sessions:
            torrent = next((t for t in torrents if t['infoHash'] == session['infoHash']), {})
            session['name'] = torrent.get('name', 'Ismeretlen film')
            session['device'] = self.config.get('devices', {}).get(session['ip'], session['ip'])
            session['tcp'] = peers.get(session['ip'])
            tcp = session['tcp'] or {}
            if tcp.get('lastack', 0) >= 30000 and tcp.get('sendQueue', 0) > 0:
                alerts.append({'code': 'client_network_' + session['ip'], 'level': 'error',
                    'message': session['device'] + ': a készülék nem nyugtázza az adatokat. Ellenőrizd a hálózatát; kábelre váltás után kapcsold ki a Wi-Fi-jét és indítsd újra a lejátszást.'})
            elif torrent and torrent.get('progress', 1) < 0.999 and now - self.history[torrent['infoHash']]['stagnant'] >= 120:
                alerts.append({'code': 'download_idle_' + session['ip'], 'level': 'warning',
                    'message': session['device'] + ': két perce nem érkezett új torrentadat. Lehet elegendő puffer, szüneteltetés vagy lassú forrás; ez önmagában nem szerverhiba.'})
        disk = dict(zip(['total', 'used', 'free'], shutil.disk_usage(self.config['mount']))) if mounted else None
        storage_error = self.storage_error() if mounted else False
        if storage_error:
            alerts.append({'code': 'disk_error', 'level': 'error', 'message': 'A rendszer friss HDD/I/O hibát jelzett. A takarítás és a szerver automatikus újraindítása szünetel; ellenőrizd a HDD tápját és USB-kábelét.'})
        if disk and disk['free'] < self.config['cleanup']['low_bytes']:
            alerts.append({'code': 'disk_low', 'level': 'warning', 'message': 'Kevés a szabad HDD-hely.'})
        self.recover(healthy, mounted and not storage_error, state, alerts)
        for alert in alerts:
            if alert['code'] not in self.alert_codes:
                self.event(alert['code'], alert['message'])
        self.alert_codes = {a['code'] for a in alerts}
        with self.lock:
            self.snapshot = {'version': VERSION, 'ready': True, 'time': now, 'healthy': healthy,
                'hddMounted': mounted, 'storageError': storage_error, 'disk': disk, 'container': {k: v for k, v in state.items() if k != 'pid'},
                'sessions': sessions, 'capacity': capacity(sessions), 'torrents': torrents, 'alerts': alerts,
                'cleanup': self.config['cleanup'], 'events': self.events[-20:], 'recoveryEnabled': self.config.get('recovery', {}).get('enabled', False)}
        return healthy, mounted, state, alerts

    def recover(self, healthy, mounted, state, alerts):
        config = self.config.get('recovery', {})
        now = self.clock()
        if healthy or not mounted or not state.get('running'):
            self.failures = 0
            return
        self.failures += 1
        alerts.append({'code': 'engine_unhealthy', 'level': 'error',
            'message': f'A szerver vagy a torrentmotor nem válaszol megfelelően. Egymást követő hibák: {self.failures}.'})
        if not config.get('enabled') or self.failures < config.get('failures', 3) or now - self.started < config.get('startup_grace', 120):
            return
        recent = [t for t in self.restarts if now - t < 3600]
        if len(recent) >= config.get('max_per_hour', 3) or (recent and now - max(recent) < config.get('cooldown', 600)):
            alerts.append({'code': 'recovery_limited', 'level': 'warning', 'message': 'Az ismételt újraindítások korlátját elérte. Kézi ellenőrzés szükséges.'})
            return
        # Reserve and persist the attempt BEFORE restart. Active video cannot defer
        # recovery of a demonstrably dead engine forever. Never restart for source/network stalls.
        self.restarts = recent + [now]
        with self.mutation:
            if not self.save(force=True) or not self.valid_mount():
                self.event('restart_blocked_storage', 'A helyreállítás előtt elveszett az írható HDD/állapot. Az újraindítás elmaradt.')
                return
        self.event('restart_attempt', 'Három egymást követő állapothiba miatt a filmkiszolgáló újraindítása. A lejátszás megszakadhat; szükség lehet újbóli indításra.')
        try:
            self.run(['docker', 'restart', '--timeout', '15', self.config['container']], 40)
            self.failures = 0
            self.event('restart_command_ok', 'Az újraindítási parancs lefutott. A működést a következő API-ellenőrzés igazolja vissza.')
        except (RuntimeError, subprocess.SubprocessError):
            self.event('restart_command_failed', 'Az automatikus újraindítás sikertelen. Kézi ellenőrzés szükséges.')

    def status(self):
        with self.lock:
            return copy.deepcopy(self.snapshot)

    def action(self, data):
        if data == {'action': 'cleanup-preview'}:
            with self.mutation:
                candidates = self.candidates()
                token = secrets.token_urlsafe(24)
                self.plans = {token: {'expires': self.clock()+120, 'hashes': [c['infoHash'] for c in candidates]}}
            return {'candidates': candidates, 'plan': token,
                'message': f'{len(candidates)} film felel meg a biztonságos takarítás feltételeinek. A részben letöltött, aktív, megőrzött és nem eléggé visszaosztott filmek kimaradnak.'}
        if set(data) == {'action', 'plan'} and data['action'] == 'cleanup':
            with self.mutation:
                plan = self.plans.pop(data['plan'], None)
                if not plan or plan['expires'] < self.clock(): raise ValueError('Lejárt takarítási lista.')
                self.pending_cleanup = list(dict.fromkeys(self.pending_cleanup + plan['hashes']))
                self.pending_auto = False
            return {'ok': True, 'message': 'A felsorolt filmek takarítása ütemezve. Az eredmény az eseményeknél jelenik meg; minden film törlése előtt újra ellenőrzi a védelmeket.'}
        if set(data) != {'action', 'infoHash', 'keep'} or data['action'] != 'keep' or type(data['keep']) is not bool or not HASH.fullmatch(data.get('infoHash', '')):
            raise ValueError('Érvénytelen művelet.')
        with self.mutation:
            item = self.ledger.get(data['infoHash'])
            if not item:
                raise ValueError('Ismeretlen letöltés.')
            if not self.valid_mount():
                raise ValueError('A HDD nem elérhető; változtatás letiltva.')
            previous = item['keep']
            item['keep'] = data['keep']
            try:
                if not self.save(force=True): raise ValueError('A megőrzési állapot nem menthető.')
            except Exception:
                item['keep'] = previous
                raise
            with self.lock:
                for torrent in self.snapshot.get('torrents', []):
                    if torrent['infoHash'] == data['infoHash']:
                        torrent['keep'] = data['keep']
        self.event('keep_changed', 'Megőrzési beállítás módosítva.')
        return {'ok': True}

    def descriptor_index(self):
        root = Path(self.config['torrents_dir'])
        if root.is_symlink() or not root.is_dir(): raise ValueError('Unsafe descriptor directory')
        result = {}
        for path in root.glob('*.torrent'):
            key, names = torrent_identity(path)
            entry = result.setdefault(key, {'paths': [], 'names': set()})
            entry['paths'].append(path)
            entry['names'].update(n.casefold() for n in names)
        return result

    def candidates(self, engine=None):
        snapshot = self.status()
        if self.state_error or not self.valid_mount() or snapshot.get('storageError') or not snapshot.get('healthy') or self.clock()-snapshot.get('time', 0) > 45:
            return []
        try: index = self.descriptor_index()
        except (ValueError, OSError, UnicodeError): return []
        torrents = engine['torrents']['data'] if engine else snapshot['torrents']
        sessions = engine['limiter']['data']['sessions'] if engine else snapshot['sessions']
        active = {s['infoHash'] for s in sessions}
        result = []
        for t in torrents:
            key = t['infoHash']
            item = self.ledger.get(key)
            desc = index.get(key)
            if not item or not desc or item['keep'] or key in active or t['progress'] < 1 or t['ratio'] < 1:
                continue
            if self.clock() - max(item['lastUsed'], item['firstSeen']) < self.config['cleanup']['min_days']*86400:
                continue
            if any(desc['names'] & other['names'] for other_key, other in index.items() if other_key != key):
                continue
            if any(suffix.casefold() == '.part' for suffix in Path(t['name']).suffixes): continue
            result.append({'infoHash': key, 'name': t['name'], 'size': t['size'], 'lastUsed': item['lastUsed']})
        return sorted(result, key=lambda t: t['lastUsed'])[:20]

    def delete_one(self, key):
        # All destructive requests go through the Go engine's lease-locked deletion.
        # Re-fetch immediately; do not trust a stale UI preview or old poll.
        if not self.valid_mount(): raise ValueError('HDD unavailable')
        engine = self.engine()
        if not all(engine.get(k, {}).get('status') == 200 for k in ('limiter', 'torrents')):
            raise ValueError('Engine unavailable')
        eligible = {t['infoHash'] for t in self.candidates(engine)}
        if key not in eligible: raise ValueError('Torrent no longer eligible')
        descriptors = self.descriptor_index()[key]['paths']
        assert HASH.fullmatch(key)
        js = "(async()=>{const r=await fetch('http://127.0.0.1:8080/torrents/"+key+"?cleanup=1',{method:'DELETE',signal:AbortSignal.timeout(12000)});console.log(JSON.stringify({status:r.status}));})().catch(()=>process.exit(1));"
        response = json.loads(self.run(['docker', 'exec', self.config['container'], 'node', '-e', js], 15))
        if response.get('status') != 200: raise ValueError('Deletion refused by engine')
        for descriptor in descriptors:
            # Revalidate identity: never unlink a descriptor replaced since planning.
            if descriptor.exists() and torrent_identity(descriptor)[0] == key:
                descriptor.unlink()
        self.ledger.pop(key, None)
        self.save(force=True)
        self.event('cleanup_deleted', 'Egy régi, visszaosztott letöltés és torrentleírója törölve: ' + key)

    def cleanup_tick(self):
        if not self.valid_mount(): return
        with self.mutation:
            if self.pending_auto and shutil.disk_usage(self.config['mount']).free >= self.config['cleanup']['target_bytes']:
                self.pending_cleanup.clear()
            key = self.pending_cleanup.pop(0) if self.pending_cleanup else None
            if not key and self.config['cleanup']['enabled'] and self.clock()-self.last_cleanup >= 3600:
                snapshot = self.status()
                if snapshot.get('disk') and snapshot['disk']['free'] < self.config['cleanup']['low_bytes']:
                    self.pending_cleanup = [t['infoHash'] for t in self.candidates()]
                    self.pending_auto = True
                    key = self.pending_cleanup.pop(0) if self.pending_cleanup else None
                    self.last_cleanup = self.clock()
                    if not key:
                        self.event('cleanup_no_candidate', 'Kevés a HDD-hely, de nincs biztonságosan törölhető film. Megőrzött vagy visszaosztásra váró fájl nem lett törölve.')
            if key:
                try: self.delete_one(key)
                except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                    self.event('cleanup_skipped', 'A takarítás egy filmet kihagyott, mert már nem teljesült minden védelmi feltétel.')
            if self.pending_cleanup and self.pending_auto:
                # Automatic cleanup stops when its target is met; manual plans also
                # revalidate every candidate but need not delete unrelated files.
                disk = shutil.disk_usage(self.config['mount'])
                if disk.free >= self.config['cleanup']['target_bytes']:
                    self.pending_cleanup.clear()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send(200, self.server.control.status()) if self.path == '/status' else self.send(404, {'error': 'Not found'})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if self.path != '/action' or not 0 < length <= 4096:
                raise ValueError('Érvénytelen kérés.')
            result = self.server.control.action(json.loads(self.rfile.read(length)))
            self.send(200, result)
        except (ValueError, TypeError, KeyError):
            self.send(400, {'error': 'Érvénytelen kérés vagy a HDD nem elérhető.'})
        except Exception:
            self.send(503, {'error': 'A művelet nem hajtható végre.'})

class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

def main():
    os.umask(0o077)
    config = json.loads(Path(os.environ.get('STREMIO_CONTROL_CONFIG', '/etc/stremio-control.json')).read_text())
    control = Control(config)
    control.load()
    sock = Path(config['socket'])
    sock.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    sock.unlink(missing_ok=True)
    server = UnixServer(str(sock), Handler)
    server.control = control
    sock.chmod(0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())
    try:
        while not STOP.is_set():
            try:
                healthy, mounted, _, _ = control.poll()
                if healthy and mounted:
                    control.cleanup_tick()
            except Exception as error:
                control.event('poll_error', 'Az állapotfigyelő lekérdezése sikertelen: ' + type(error).__name__)
            STOP.wait(config.get('interval', 15))
    finally:
        control.save(force=True)
        server.shutdown()
        server.server_close()
        sock.unlink(missing_ok=True)

if __name__ == '__main__':
    main()
