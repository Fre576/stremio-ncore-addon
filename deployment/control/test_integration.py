#!/usr/bin/env python3
"""Build and test a separate local-only container. Production is untouched."""
import hashlib
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
import socketserver
import threading

assert os.geteuid() == 0
os.umask(0o077)
setup = Path(os.environ.get('STREMIO_TEST_SETUP', '/opt/stremio-ncore'))
version=next((arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--version=')),'0.8.4')
assert version in ['0.8.4','0.8.5','0.8.6','0.8.7']
image = ('stremio-ncore-addon:control-' if version in ['0.8.6','0.8.7'] else 'stremio-ncore-addon:ip-limiter-')+version
name = 'stremio-ncore-limiter-test'
report_path = setup / 'limiter-build-test.json'
log_path = setup / 'limiter-build-test.log'
log = log_path.open('w', buffering=1)
os.chown(log_path,int(os.environ.get('STREMIO_TEST_UID','0')),int(os.environ.get('STREMIO_TEST_GID','0')))
report = {'status':'BUILDING','tests':[]}
started = False
control_server = None
def save(status):
    report['status']=status
    report_path.write_text(json.dumps(report,indent=2))
    os.chown(report_path,int(os.environ.get('STREMIO_TEST_UID','0')),int(os.environ.get('STREMIO_TEST_GID','0')))
    print(status,flush=True)
def run(args):
    subprocess.run(args,check=True,stdout=log,stderr=log)
def http(port,path,method='GET',headers=None,body=None):
    req=urllib.request.Request('http://127.0.0.1:'+str(port)+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**(headers or {})},method=method)
    try:
        with urllib.request.urlopen(req,timeout=15) as r:return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
def check(label,actual,expected):
    assert actual==expected,label+': '+str(actual)+' != '+str(expected)
    report['tests'].append(label)
def encode(v):
    if isinstance(v,int):return b'i'+str(v).encode()+b'e'
    if isinstance(v,bytes):return str(len(v)).encode()+b':'+v
    return b'd'+b''.join(encode(k)+encode(v[k]) for k in sorted(v))+b'e'
try:
    save('INTEGRATION_TESTING' if '--test-only' in sys.argv else 'BUILDING')
    source=Path(os.environ.get('STREMIO_TEST_SOURCE',str(setup/('source-ip-limiter-'+version))))
    if '--test-only' not in sys.argv:
        assert not source.exists(),'Source target already exists; stopped.'
        source.mkdir()
        with tarfile.open(setup/('source-limiter-'+version+'.tar')) as archive:archive.extractall(source,filter='data')
        run(['docker','build','-t',image,str(source)])
    else:
        assert source.is_dir()
        run(['docker','image','inspect','--format','{{.Id}}',image])
    save('INTEGRATION_TESTING')
    report['image']=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',image],text=True).strip()
    fixture=setup/'limiter-tests'/str(int(time.time()))
    (fixture/'downloads').mkdir(parents=True)
    (fixture/'config').mkdir()
    if version in ['0.8.6','0.8.7']:
        (fixture/'control-socket').mkdir()
        class FakeControl(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def reply(self,data):
                body=json.dumps(data).encode();self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            def do_GET(self):self.reply({'healthy':True,'marker':'isolated-control'})
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length','0')));self.reply({'ok':True})
        class UnixServer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
        control_server=UnixServer(str(fixture/'control-socket/control.sock'),FakeControl)
        threading.Thread(target=control_server.serve_forever,daemon=True).start()
    with sqlite3.connect(setup/'data/config/sna.db') as db,sqlite3.connect(fixture/'config/sna.db') as clone:db.backup(clone)
    with sqlite3.connect(fixture/'config/sna.db') as db:
        db.execute('UPDATE configuration SET delete_after_hitnrun=0')
        user=db.execute('SELECT id FROM users LIMIT 1').fetchone()[0]
        db.execute('DELETE FROM device_tokens')
        db.execute('INSERT INTO device_tokens(token,name,user_id) VALUES(?,?,?)',('limiter-local-test','Isolated integration test',user))
        if version in ['0.8.6','0.8.7']:
            admin=db.execute("SELECT id FROM users WHERE role='admin' LIMIT 1").fetchone()[0]
            db.execute('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)',(hashlib.sha256(b'control-integration-admin').hexdigest(),admin,int((time.time()+3600)*1000)))
    # A distinct Docker name is required; never replace an existing container.
    existing=subprocess.check_output(['docker','ps','-a','--format','{{.Names}}'],text=True).splitlines()
    assert name not in existing
    extra_mount=['--mount','type=bind,src='+str(fixture/'control-socket')+',dst=/run/stremio-control,readonly'] if version in ['0.8.6','0.8.7'] else []
    run(['docker','run','-d','--name',name,'-e','NCORE_USERNAME=isolated-test','-e','NCORE_PASSWORD=isolated-test','-p','127.0.0.1:18080:8080','-p','127.0.0.1:13000:3000','--mount','type=bind,src='+str(fixture)+',dst=/addon']+extra_mount+[image])
    started=True
    for attempt in range(60):
        try:
            if http(13000,'/manifest.json')[0]==200:break
        except Exception:pass
        time.sleep(1)
    else:raise RuntimeError('Isolated Node server did not start')
    hashes={}
    def fixture_filename(title):
        return 'limiter-fixture.'+title+('.UHD' if version=='0.8.7' and title=='A.1080p' else '')+'.mkv'
    for title in ['A.1080p','B.1080p','C.1080p','D.2160p']:
        filename=fixture_filename(title)
        data=(title.encode()*8192)[:32768]
        if version in ['0.8.5','0.8.6','0.8.7'] and title=='A.1080p':data=b'A'*(64*1024*1024)
        (fixture/'downloads'/filename).write_bytes(data)
        pieces=b''.join(hashlib.sha1(data[i:i+32768]).digest() for i in range(0,len(data),32768))
        info={b'name':filename.encode(),b'length':len(data),b'piece length':32768,b'pieces':pieces,b'private':1}
        hashes[title]=hashlib.sha1(encode(info)).hexdigest()
        path=fixture/(title+'.torrent');path.write_bytes(encode({b'info':info}))
        check('add '+title,http(18080,'/torrents','POST',body={'path':'/addon/'+path.name,'verify':True})[0],200)
    def file(title,ip,method='GET'):
        return http(18080,'/torrents/'+hashes[title]+'/files/'+fixture_filename(title),method,{'Range':'bytes=0-63','X-Stremio-Client-IP':ip})[0]
    def state():return json.loads(http(18080,'/playback-limiter')[1])
    check('HEAD does not reserve',file('D.2160p','10.90.0.1','HEAD'),200)
    check('no HEAD session',len(state()['sessions']),0)
    check('first HD',file('A.1080p','10.90.0.1'),206)
    if version=='0.8.7':
        check('1080p.UHD source gets HD lease',state()['sessions'][0]['quality'],'1080p')
    check('second HD',file('B.1080p','10.90.0.2'),206)
    if version=='0.8.7':check('second TV admitted alongside 1080p.UHD source',len(state()['sessions']),2)
    check('third HD rejected',file('C.1080p','10.90.0.3'),429)
    check('4K rejected during HD',file('D.2160p','10.90.0.3'),429)
    check('same-IP blocked 4K upgrade',file('D.2160p','10.90.0.1'),429)
    check('old movie preserved',next(s['infoHash'] for s in state()['sessions'] if s['ip']=='10.90.0.1'),hashes['A.1080p'])
    check('same-IP HD replacement',file('C.1080p','10.90.0.1'),206)
    check('still two clients',len(state()['sessions']),2)
    # A fresh manager tests exclusive 4K independently of the HD leases.
    run(['docker','restart',name])
    for attempt in range(30):
        try:
            if http(18080,'/playback-limiter')[0]==200:break
        except Exception:pass
        time.sleep(1)
    # The .torrent files were not placed in /addon/torrents: reload fixtures explicitly.
    for title in hashes:http(18080,'/torrents','POST',body={'path':'/addon/'+title+'.torrent','verify':True})
    check('exclusive 4K admitted',file('D.2160p','10.90.0.1'),206)
    check('HD rejected during 4K',file('B.1080p','10.90.0.2'),429)
    check('second 4K rejected',file('D.2160p','10.90.0.2'),429)
    # Test real Node->Go forwarding, including malicious client-provided headers.
    run(['docker','restart',name])
    for attempt in range(40):
        try:
            if http(13000,'/manifest.json')[0]==200:break
        except Exception:pass
        time.sleep(1)
    http(18080,'/torrents','POST',body={'path':'/addon/A.1080p.torrent','verify':True})
    route='/api/auth/limiter-local-test/stream/play/ncore/fixture/'+hashes['A.1080p']+'/0'
    check('Node HEAD proxy',http(13000,route,'HEAD',headers={'X-Stremio-Client-IP':'10.99.99.99'})[0],200)
    check('Node HEAD no slot',len(state()['sessions']),0)
    check('Node GET range proxy',http(13000,route,headers={'Range':'bytes=0-63','X-Stremio-Client-IP':'10.99.99.99','X-Forwarded-For':'10.88.88.88'})[0],206)
    clients=state()['sessions']
    assert len(clients)==1 and clients[0]['ip'] not in ['10.99.99.99','10.88.88.88']
    report['tests'].append('client IP derived from socket; spoofed headers ignored')
    if version in ['0.8.5','0.8.6','0.8.7']:
        before=subprocess.check_output(['docker','inspect','--format','{{.State.StartedAt}}',name],text=True).strip()
        for attempt in range(10):
            connection=HTTPConnection('127.0.0.1',13000,timeout=10)
            connection.request('GET',route)
            response=connection.getresponse()
            assert response.status==200
            assert response.read(1024)
            connection.close()
            time.sleep(0.2)
            check('Node survives client disconnect '+str(attempt+1),http(13000,'/manifest.json')[0],200)
        after=subprocess.check_output(['docker','inspect','--format','{{.State.StartedAt}}',name],text=True).strip()
        check('No Node/container restart during disconnects',after,before)
    if version in ['0.8.6','0.8.7']:
        check('Active torrent deletion refused',http(18080,'/torrents/'+hashes['A.1080p'],'DELETE')[0],409)
        http(18080,'/torrents','POST',body={'path':'/addon/B.1080p.torrent','verify':True})
        for attempt in range(50):
            if json.loads(http(18080,'/torrents/'+hashes['B.1080p'])[1])['progress']==1:break
            time.sleep(.1)
        check('Cleanup refuses unseeded torrent',http(18080,'/torrents/'+hashes['B.1080p']+'?cleanup=1','DELETE')[0],409)
        protected=fixture/'downloads/must-keep.txt';protected.write_text('untouched')
        check('Idle torrent deletion succeeds',http(18080,'/torrents/'+hashes['B.1080p'],'DELETE')[0],200)
        check('Deleted data removed',(fixture/'downloads/limiter-fixture.B.1080p.mkv').exists(),False)
        check('Unrelated files preserved',protected.read_text(),'untouched')
        cookie={'Cookie':'session=control-integration-admin'}
        check('Control requires login',http(13000,'/api/control/status')[0],401)
        check('Control admin authorized',http(13000,'/api/control/status',headers=cookie)[0],200)
        check('Control Unix socket reached',json.loads(http(13000,'/api/control/status',headers=cookie)[1])['marker'],'isolated-control')
        check('Control CSRF rejected',http(13000,'/api/control/action','POST',headers={**cookie,'Origin':'https://untrusted.example'},body={'action':'keep'})[0],403)
        check('Control missing Origin rejected',http(13000,'/api/control/action','POST',headers=cookie,body={'action':'keep'})[0],403)
        check('Control same-origin action forwarded',http(13000,'/api/control/action','POST',headers={**cookie,'Origin':'http://127.0.0.1:13000'},body={'action':'keep'})[0],200)
        for asset in ['index.html','app.js','style.css','manifest.webmanifest','icon.png']:
            check('Dashboard asset '+asset,http(13000,'/control/'+asset)[0],200)
        check('Dashboard is actual static page',b'loginForm' in http(13000,'/control/index.html')[1],True)
        check('Dashboard home route works',b'loginForm' in http(13000,'/control/')[1],True)
        sys.path.insert(0,str(source/'deployment/control'))
        from control import Control
        recovery_config={'mount':str(fixture),'uuid':'TEST-ONLY','container':name,'web_url':'http://127.0.0.1:13000',
            'cleanup':{'enabled':False,'low_bytes':1,'target_bytes':2,'min_days':30},
            'recovery':{'enabled':True,'startup_grace':0,'failures':3,'cooldown':600,'max_per_hour':3}}
        watcher=Control(recovery_config)
        watcher.valid_mount=lambda:True
        watcher.storage_error=lambda:False
        check('Real watchdog initial health',watcher.poll()[0],True)
        run(['docker','exec',name,'sh','-c','kill $(pidof torrent-server)'])
        watcher.poll();watcher.poll()
        check('Real watchdog waits for three failures',len(watcher.restarts),0)
        watcher.poll()
        check('Real watchdog restarts isolated container',len(watcher.restarts),1)
        for attempt in range(40):
            if watcher.poll()[0]:break
            time.sleep(1)
        check('Real watchdog confirms API recovery',watcher.status()['healthy'],True)
    manifest=json.loads(http(13000,'/manifest.json')[1]);check('manifest version',manifest['version'],version)
    save('TESTED')
except Exception as error:
    report['error_type']=type(error).__name__
    log.write('\nBUILD/TEST ERROR: '+str(error)+'\n')
    save('FAILED')
    raise
finally:
    if started:
        run(['docker','stop','--timeout','5',name])
        run(['docker','rm',name])
    if control_server:
        control_server.shutdown();control_server.server_close()
