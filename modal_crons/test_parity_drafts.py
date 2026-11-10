import ast
import contextlib
import io
import json
from pathlib import Path
import types
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


def load_collector():
    text = (ROOT / 'tick_collector.py').read_text()
    tree = ast.parse(text[text.index('import asyncio, base64'):])
    module = types.ModuleType('collector_draft')
    exec(compile(tree, str(ROOT / 'tick_collector.py'), 'exec'), module.__dict__)
    return module


class DraftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collector = load_collector()
        try:
            import tick_shadow_reconcile
        except ImportError:
            cls.reconcile = None
        else:
            cls.reconcile = tick_shadow_reconcile

    def test_live_disabled(self):
        self.assertIs(self.collector.CONFIG['live'], False)

    def test_vnd_capture_disabled_has_no_sample_ring(self):
        agg = types.SimpleNamespace(on_match=lambda *args: None)
        adapter = self.collector.VndirectAdapter(agg, ['VCB'])
        self.assertIsNone(adapter._st_samples)
        self.assertEqual(len(adapter._st_samples or []), 0)

    def test_vnd_collision_keeps_dedup_and_bounded_samples(self):
        events = []
        agg = types.SimpleNamespace(on_match=lambda *args: events.append(args))
        with patch.dict(self.collector.CONFIG, {'vndirect_capture_enabled': True}):
            adapter = self.collector.VndirectAdapter(agg, ['VCB'])
        for _ in range(300):
            adapter._on_msg('ST|VCB|10:00:00|x|53.8|10|id')
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0][4], 100)
        self.assertEqual(adapter.st_stats['key_collisions'], 299)
        self.assertEqual(len(adapter._st_samples), 256)
        json.dumps(adapter.st_stats)

    def test_dns_failure_records_phase_without_exception_secrets(self):
        import asyncio
        import sys
        fake_client = types.ModuleType('websockets.asyncio.client')
        fake_client.connect = lambda *args, **kwargs: self.fail('connection after failed DNS')
        client = self.collector.MqttWs('wss://example.invalid/wss', '', '', [], lambda *args: None)
        async def fail_dns(*args, **kwargs):
            client.stop()
            raise OSError('sensitive exception text')
        async def exercise():
            with patch.object(asyncio.get_running_loop(), 'getaddrinfo', side_effect=fail_dns):
                await client.run()
        with patch.dict(sys.modules, {'websockets.asyncio.client': fake_client}), contextlib.redirect_stdout(io.StringIO()) as output:
            asyncio.run(exercise())
        self.assertEqual(client.transport_diag['last_failure']['phase'], 'dns')
        self.assertNotIn('sensitive exception text', output.getvalue())
        json.dumps(client.transport_diag)

    def test_dnse_atc_not_session_total(self):
        snapshots = []
        agg = types.SimpleNamespace(gate_stats={}, on_snapshot=lambda *args: snapshots.append(args))
        adapter = self.collector.DnseAdapter(agg, ['VCB'])
        with patch.object(self.collector, 'pb_decode', return_value={'f41': {'f22': 12}}):
            adapter._on_msg('quotes/stockinfo/VCB', b'')
        snap = snapshots[0][2]
        self.assertEqual(snap['atc_volume'], 120)
        self.assertNotIn('total_volume', snap)

    def test_field_comparability_and_rounding(self):
        if self.reconcile is None:
            self.skipTest('tick_shadow_reconcile is unavailable')
        fn = self.reconcile.compare_field
        self.assertEqual(fn(10, 11, field='room')['status'],
                         'not comparable: timestamp/basis/units unverified')
        common = dict(left_time='t', right_time='t', left_basis='matched', right_basis='matched',
                      left_unit='shares', right_unit='shares')
        self.assertEqual(fn(10, 11, field='room', **common)['status'], 'rounding-sized')
        self.assertEqual(fn(10, 11, field='foreign_buy', **common)['status'], 'material difference')
        self.assertEqual(fn(None, 11, field='room')['status'], 'unmeasured')

    def test_missing_dnse_total_is_explicit(self):
        if self.reconcile is None:
            self.skipTest('tick_shadow_reconcile is unavailable')
        report = {'candles': {}}
        self.reconcile.analyze_status(report, {'diag': {'foreign_by_src': {'dnse': {'VCB': {'atc_volume': 10}}}}})
        self.assertEqual(report['field_id']['status'], 'not comparable')

    def test_reconcile_auction_missing_and_failed_reference(self):
        if self.reconcile is None:
            self.skipTest('tick_shadow_reconcile is unavailable')
        r = self.reconcile
        bars = [{'t': '2026-11-10T14:44', 'c': 10, 'v': 100},
                {'t': '2026-11-10T14:45', 'c': 10, 'v': 200}]
        response = {'bars': {b['t']: dict(b) for b in bars}, 'retrieved_at': 'now',
                    'session_date': '2026-11-10'}
        def get(key):
            return {'rows': bars} if '/intraday/' in key else {}
        captured = io.StringIO()
        captured.fileno = lambda: 1
        output = ROOT / 'tick_shadow_reconcile.json'
        with patch.object(r, 'r2_get', side_effect=get), patch.object(r, 'dchart_1m', side_effect=[response, OSError('fixture failure'), OSError('fixture failure'), OSError('fixture failure')]), patch.object(r.df, 'kbs_price_board', return_value={}), patch.object(r.time, 'sleep'), patch.object(r.tempfile, 'mkstemp', return_value=(5, str(output) + '.unique')), patch.object(r.os, 'fchmod'), patch.object(r.os, 'fdopen', return_value=contextlib.nullcontext(captured)), patch.object(r.os, 'fsync'), patch.object(r.os, 'replace') as replace, patch.object(r.os, 'unlink'), contextlib.redirect_stdout(io.StringIO()):
            r.main(['VCB', 'FPT'], '2026-11-10', 'fixture')
        report = json.loads(captured.getvalue())
        self.assertEqual(report['candles']['VCB']['auction_shadow_volume'], 200)
        self.assertEqual(report['candles']['VCB']['continuous_shadow_volume'], 100)
        self.assertEqual(report['candles']['FPT']['status'], 'unmeasured')
        self.assertEqual(len(report['reference_failures']), 1)
        self.assertIn('VCB', report['reference_snapshots'])
        replace.assert_called_once_with(str(output) + '.unique', str(output))


if __name__ == '__main__':
    unittest.main(verbosity=2)
