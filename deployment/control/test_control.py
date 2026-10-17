import copy
import json
from pathlib import Path
import tempfile
import unittest
from control import Control, capacity, torrent_identity
import hashlib

def config(root):
    return {'mount': str(root), 'uuid': 'TEST', 'container': 'isolated-test',
        'cleanup': {'enabled': True, 'low_bytes': 200 * 1024**3, 'target_bytes': 300 * 1024**3, 'min_days': 30},
        'recovery': {'enabled': True, 'startup_grace': 120, 'failures': 3, 'cooldown': 600, 'max_per_hour': 3}}

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = 100000
        self.calls = []
        self.c = Control(config(self.root), clock=lambda: self.now, runner=self.run_command)
        self.c.valid_mount = lambda: True
        self.c.inspect = lambda: {'running': True, 'pid': 123, 'restarts': 0}
        self.c.tcp = lambda pid: {}
        self.c.storage_error = lambda: False
        self.engine = {'manifest': {'status': 200}, 'limiter': {'status': 200, 'data': {'sessions': []}}, 'torrents': {'status': 200, 'data': []}}
        self.c.engine = lambda: copy.deepcopy(self.engine)

    def tearDown(self):
        self.temp.cleanup()

    def run_command(self, args, timeout=12):
        self.calls.append(args)
        return ''

    def test_capacity(self):
        self.assertTrue(capacity([])['can4K'])
        self.assertEqual(capacity([{'quality': '1080p'}])['freeHD'], 1)
        self.assertEqual(capacity([{'quality': '4k'}])['freeHD'], 0)

    def test_snapshot_rates_and_keep_persistence(self):
        t = {'infoHash': 'a'*40, 'name': '<script>unsafe</script>', 'downloaded': 10, 'uploaded': 0, 'progress': .1, 'size': 100, 'ratio': 0}
        self.engine['torrents']['data'] = [t]
        self.c.poll()
        self.now += 10
        t['downloaded'] = 110
        self.c.poll()
        self.assertEqual(self.c.status()['torrents'][0]['downloadRate'], 10)
        self.c.action({'action': 'keep', 'infoHash': 'a'*40, 'keep': True})
        saved = json.loads((self.c.root / 'control/state.json').read_text())
        self.assertTrue(saved['torrents']['a'*40]['keep'])
        s = self.c.status()
        s['torrents'].clear()
        self.assertEqual(len(self.c.status()['torrents']), 1)

    def test_missing_mount_never_writes_or_restarts(self):
        self.c.valid_mount = lambda: False
        for _ in range(5):
            self.now += 200
            self.c.poll()
        self.assertFalse(self.c.root.exists())
        self.assertFalse(self.calls)
        self.assertEqual(self.c.status()['alerts'][0]['code'], 'hdd_missing')

    def test_mutation_rejects_invalid_requests(self):
        for data in [{}, {'action': 'shell'}, {'action': 'keep', 'infoHash': '../x', 'keep': True}, {'action': 'keep', 'infoHash': 'a'*40, 'keep': 'yes'}]:
            with self.assertRaises(ValueError):
                self.c.action(data)

    def test_recovery_requires_three_failures_and_has_cooldown(self):
        self.now += 121
        self.engine['torrents']['status'] = 0
        self.c.poll(); self.c.poll()
        self.assertFalse(self.calls)
        self.c.poll()
        self.assertEqual(self.calls, [['docker', 'restart', '--timeout', '15', 'isolated-test']])
        for _ in range(5): self.c.poll()
        self.assertEqual(len(self.calls), 1)
        self.now += 601
        self.c.poll()
        self.assertEqual(len(self.calls), 2)

    def test_healthy_or_intentionally_stopped_resets_failures(self):
        self.now += 121
        self.engine['manifest']['status'] = 0
        self.c.poll(); self.c.poll()
        self.engine['manifest']['status'] = 200
        self.c.poll()
        self.assertEqual(self.c.failures, 0)
        self.c.inspect = lambda: {'running': False}
        for _ in range(5): self.c.poll()
        self.assertFalse(self.calls)

    def test_network_failure_does_not_restart_healthy_engine(self):
        self.engine['limiter']['data']['sessions'] = [{'ip': '192.168.1.240', 'infoHash': 'b'*40, 'quality': '1080p', 'connections': 1}]
        self.c.tcp = lambda pid: {'192.168.1.240': {'lastack': 74000, 'sendQueue': 2500000}}
        self.now += 200
        for _ in range(4): self.c.poll()
        self.assertTrue(any(a['code'].startswith('client_network') for a in self.c.status()['alerts']))
        self.assertFalse(self.calls)

    def test_tcp_parser(self):
        self.c.run = lambda *a: 'ESTAB 0 2551744 [::ffff:172.18.0.2]:3443 [::ffff:192.168.1.165]:58808\n cubic lastack:74002 bytes_acked:91526505 lost:142'
        tcp = Control.tcp(self.c, 1)['192.168.1.165']
        self.assertEqual(tcp['lastack'], 74002)
        self.assertEqual(tcp['sendQueue'], 2551744)

    def test_recovery_hour_limit_and_startup_grace(self):
        self.engine['manifest']['status'] = 0
        for _ in range(4): self.c.poll()
        self.assertFalse(self.calls)
        self.now += 121
        for _ in range(3):
            for _ in range(3): self.c.poll()
            self.now += 601
        self.assertEqual(len(self.calls), 3)
        for _ in range(4): self.c.poll()
        self.assertEqual(len(self.calls), 3)

    def make_cleanup_fixture(self):
        folder = self.root / 'descriptors'
        folder.mkdir()
        info = b'd6:lengthi100e4:name11:film.1080pXe'
        raw = b'd4:info' + info + b'e'
        key = hashlib.sha1(info).hexdigest()
        (folder / 'film.torrent').write_bytes(raw)
        self.c.config['torrents_dir'] = str(folder)
        self.engine['torrents']['data'] = [{'infoHash': key, 'name': 'film.1080pX', 'downloaded': 100, 'uploaded': 100, 'progress': 1, 'size': 100, 'ratio': 1}]
        self.c.poll()
        self.now += 31*86400
        self.c.poll()
        return key, folder

    def test_cleanup_filters_keep_active_partial_ratio_and_age(self):
        key, _ = self.make_cleanup_fixture()
        self.assertEqual(len(self.c.candidates()), 1)
        self.c.ledger[key]['keep'] = True
        self.assertEqual(self.c.candidates(), [])
        self.c.ledger[key]['keep'] = False
        self.c.snapshot['sessions'] = [{'infoHash': key}]
        self.assertEqual(self.c.candidates(), [])
        self.c.snapshot['sessions'] = []
        for field,value in [('progress', .99), ('ratio', .99)]:
            self.c.snapshot['torrents'][0][field] = value
            self.assertEqual(self.c.candidates(), [])
            self.c.snapshot['torrents'][0][field] = 1
        self.c.ledger[key]['lastUsed'] = self.now-10
        self.assertEqual(self.c.candidates(), [])

    def test_descriptor_fail_closed_and_shared_paths(self):
        key, folder = self.make_cleanup_fixture()
        with self.assertRaises(ValueError):
            bad = folder / 'bad.torrent'; bad.write_bytes(b'not-bencode'); torrent_identity(bad)
        self.assertEqual(self.c.candidates(), [])
        bad.unlink()
        info = b'd6:lengthi101e4:name11:film.1080pXe'
        (folder / 'shared.torrent').write_bytes(b'd4:info'+info+b'e')
        self.assertEqual(self.c.candidates(), [])

    def test_preview_expiry_and_keep_rechecked_at_execution(self):
        key, _ = self.make_cleanup_fixture()
        plan = self.c.action({'action':'cleanup-preview'})
        self.assertEqual(len(plan['candidates']), 1)
        self.now += 121
        with self.assertRaises(ValueError): self.c.action({'action':'cleanup','plan':plan['plan']})
        self.c.poll()
        plan = self.c.action({'action':'cleanup-preview'})
        self.c.action({'action':'cleanup','plan':plan['plan']})
        self.c.ledger[key]['keep'] = True
        with self.assertRaises(ValueError): self.c.delete_one(key)
        self.assertFalse(self.calls)

    def test_successful_cleanup_only_unlinks_matching_descriptor(self):
        key, folder = self.make_cleanup_fixture()
        protected = self.root / 'PS5_GAMES-do-not-touch.txt'
        protected.write_text('keep original')
        self.c.run = lambda args, timeout=12: json.dumps({'status':200})
        self.c.delete_one(key)
        self.assertFalse((folder / 'film.torrent').exists())
        self.assertEqual(protected.read_text(), 'keep original')
        self.assertNotIn(key, self.c.ledger)

    def test_engine_refusal_keeps_descriptors_and_ledger(self):
        key, folder = self.make_cleanup_fixture()
        self.c.run = lambda args, timeout=12: json.dumps({'status':409})
        with self.assertRaises(ValueError): self.c.delete_one(key)
        self.assertTrue((folder / 'film.torrent').exists())
        self.assertIn(key, self.c.ledger)

    def test_disk_error_suppresses_recovery_and_cleanup(self):
        self.make_cleanup_fixture()
        self.c.storage_error = lambda: True
        self.engine['manifest']['status'] = 0
        self.now += 200
        for _ in range(4): self.c.poll()
        self.assertFalse(self.calls)
        self.assertEqual(self.c.candidates(), [])

    def test_automatic_queue_stops_before_next_deletion_at_target(self):
        self.c.config['cleanup']['target_bytes'] = 1
        self.c.config['cleanup']['low_bytes'] = 0
        self.c.pending_auto = True
        self.c.pending_cleanup = ['a'*40]
        deleted = []
        self.c.delete_one = lambda key: deleted.append(key)
        self.c.cleanup_tick()
        self.assertEqual(deleted, [])
        self.assertEqual(self.c.pending_cleanup, [])

    def test_corrupt_state_is_preserved_and_disables_destructive_automation(self):
        folder = self.c.root / 'control'
        folder.mkdir(parents=True)
        path = folder / 'state.json'
        path.write_text('broken-original-state')
        self.c.load()
        self.c.poll()
        self.assertTrue(self.c.state_error)
        self.assertFalse(self.c.config['cleanup']['enabled'])
        self.assertFalse(self.c.config['recovery']['enabled'])
        self.assertEqual(path.read_text(), 'broken-original-state')
        self.assertEqual(self.c.candidates(), [])

    def test_failed_keep_persistence_rolls_back_in_memory_flag(self):
        self.c.ledger['a'*40] = {'firstSeen':self.now,'lastUsed':self.now,'keep':True}
        self.c.save = lambda force=False: False
        with self.assertRaises(ValueError):
            self.c.action({'action':'keep','infoHash':'a'*40,'keep':False})
        self.assertTrue(self.c.ledger['a'*40]['keep'])

if __name__ == '__main__':
    unittest.main()
