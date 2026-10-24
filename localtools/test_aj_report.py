import json
import tempfile
import time
import unittest
from pathlib import Path

import aj_report
import browser


class RunGuard(unittest.TestCase):
    def test_no_run_no_limits(self):
        self.assertEqual(browser.run_refusal({}, True, None, 0), '')

    def test_wrong_market_account_or_time_is_refused(self):
        self.assertIn('OTC pairs only', browser.run_refusal({'market': 'otc'}, True, 'demo', 0))
        self.assertIn('real (non-OTC)', browser.run_refusal({'market': 'real'}, False, 'demo', 0))
        self.assertIn('shows the demo account', browser.run_refusal({'account': 'real'}, True, 'demo', 0))
        self.assertIn('does not show which', browser.run_refusal({'account': 'demo'}, True, None, 0))
        self.assertIn('time limit', browser.run_refusal({'until': 10}, True, 'demo', 11))

    def test_a_trade_inside_the_limits_goes_ahead(self):
        run = {'market': 'any', 'account': 'demo', 'until': 100}
        self.assertEqual(browser.run_refusal(run, False, 'demo', 50), '')

    def test_limits_come_from_the_trading_mode_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'mode.json'
            old, browser.TRADING_MODE_FILE = browser.TRADING_MODE_FILE, p
            try:
                p.write_text(json.dumps({'obviousOnly': True, 'run': {'market': 'otc'}}))
                self.assertEqual(browser.run_limits(), {'market': 'otc'})
                p.write_text(json.dumps({'obviousOnly': True}))
                self.assertEqual(browser.run_limits(), {})
            finally:
                browser.TRADING_MODE_FILE = old


class Report(unittest.TestCase):
    board = {
        'options': {'weekly_puts': {'open': {'short': 750.0, 'long': 745.0, 'expiry': '2026-10-30', 'credit': 0.98},
                                    'trades': 0},
                    'edges': {'SPY': {'fading_fear': False, 'stretched': True}}, 'picks': [],
                    'autopilot': {'mode': 'off'}},
        'sports': {'paper_edges': {'NBA totals': {'bets': 4, 'open': 3, 'win_rate': 0.75, 'profit': 17.3}},
                   'parlays': 0, 'real_bets_placed': 0},
        'pocket': {'day': {'trades': 0}, 'all': {'trades': 10, 'win_rate': 0.5, 'profit': -5}},
        'jobs': [{'name': 'OpenDots NBA Totals', 'last': '2026-10-23 10:30', 'result': 1},
                 {'name': 'OpenDots NHL Puck Line', 'last': '2026-10-23 11:00', 'result': 267009}],
    }

    def test_speech_is_plain_sentences_about_every_record(self):
        speech = aj_report.report(self.board)['speech']
        self.assertIn('750 over 745 put, expiring October 30, sold for $0.98', speech)
        self.assertIn('stretched calls on SPY', speech)
        self.assertIn('NBA totals: 3 won of 4 settled, $17.30 on paper, 3 still open.', speech)
        self.assertIn('1 scheduled job failed', speech)
        self.assertNotIn('|', speech)

    def test_problems_are_failed_jobs_and_alerts_that_need_the_owner(self):
        with tempfile.TemporaryDirectory() as d:
            alerts = Path(d) / 'alerts.jsonl'
            alerts.write_text('\n'.join(json.dumps(a) for a in [
                {'at': time.time(), 'event': 'paper pick', 'title': 'Weekly put spread (paper)'},
                {'at': time.time(), 'event': 'trailing stop', 'title': 'Close SPY spread', 'message': 'Press it'}]))
            old, aj_report.ALERTS = aj_report.ALERTS, alerts
            try:
                found = aj_report.problems(self.board, 0)
            finally:
                aj_report.ALERTS = old
        titles = [p['title'] for p in found]
        self.assertIn('NBA Totals failed', titles)
        self.assertIn('Close SPY spread', titles)
        self.assertNotIn('NHL Puck Line failed', titles)
        self.assertNotIn('Weekly put spread (paper)', titles)


if __name__ == '__main__':
    unittest.main()
