"""Compare two local models on OpenDots-style work: tool calls and coding.

usage: python bench.py <label> <base_url> <model> <runs> <out.json>
Every task is scored by code (argument checks, unit tests), not by eye.
"""
import json, re, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

label, base, model, runs, out = sys.argv[1], sys.argv[2].rstrip('/'), sys.argv[3], int(sys.argv[4]), sys.argv[5]

TOOLS = [
    {'type': 'function', 'function': {'name': 'browser_scan_pairs', 'description': 'Scan currency pairs and rate their trends.',
        'parameters': {'type': 'object', 'properties': {'count': {'type': 'integer'}, 'market': {'type': 'string', 'enum': ['otc', 'real']}},
                       'required': ['market']}}},
    {'type': 'function', 'function': {'name': 'browser_place_trade', 'description': 'Place a demo trade on the current pair.',
        'parameters': {'type': 'object', 'properties': {'direction': {'type': 'string', 'enum': ['buy', 'sell']},
                       'reason': {'type': 'string', 'description': 'One line naming what you saw.'},
                       'expiry': {'type': 'string', 'description': 'e.g. 11s, 1m, 3m'}}, 'required': ['direction', 'reason']}}},
    {'type': 'function', 'function': {'name': 'site_add', 'description': 'Save a learned website operation.',
        'parameters': {'type': 'object', 'properties': {'site': {'type': 'string'}, 'operation': {'type': 'string'},
                       'trigger': {'type': 'string', 'description': 'Page URL with {param} slots'},
                       'example': {'type': 'object'}, 'example2': {'type': 'object'},
                       'write': {'type': 'boolean', 'description': 'True when the operation changes state (submit, order, post).'}},
                       'required': ['site', 'operation', 'trigger', 'example']}}},
]
SYSTEM_TOOLS = 'You operate OpenDots tools. When a tool fits the request, call it with exact arguments. Otherwise answer briefly.'


def tool_task(name, prompt, check):
    return {'name': name, 'kind': 'tool', 'prompt': prompt, 'check': check}


def call(args_of, fn):
    return lambda calls: len(calls) == 1 and calls[0][0] == fn and args_of(calls[0][1])


TOOL_TASKS = [
    tool_task('scan_real', 'Scan 6 of the real (non-OTC) pairs.',
              call(lambda a: a.get('market') == 'real' and int(a.get('count', 0)) == 6, 'browser_scan_pairs')),
    tool_task('sell_3m', 'Sell EUR/USD with a 3 minute expiry: RSI 74 and falling, MACD just crossed down.',
              call(lambda a: a.get('direction') == 'sell' and str(a.get('expiry', '')).replace(' ', '').lower() in ('3m', '3min', '180s')
                   and len(a.get('reason', '')) > 5, 'browser_place_trade')),
    tool_task('site_read', 'Save the search on books.test as operation "search" of site "books": the page is '
              'https://books.test/s?q={q}; use the examples q=dune and q=foundation.',
              call(lambda a: a.get('site') == 'books' and a.get('operation') == 'search' and a.get('trigger') == 'https://books.test/s?q={q}'
                   and a.get('example') == {'q': 'dune'} and a.get('example2') == {'q': 'foundation'} and not a.get('write'), 'site_add')),
    tool_task('site_write', 'Map the submit button of the new-note form as site "notes", operation "create". The form page is '
              'https://notes.test/new and the field is note; examples note=hi and note=bye. Submitting creates a note.',
              call(lambda a: a.get('site') == 'notes' and a.get('operation') == 'create' and a.get('write') is True
                   and a.get('example') == {'note': 'hi'} and a.get('example2') == {'note': 'bye'}, 'site_add')),
    tool_task('no_tool', 'Quick question, no tools needed: what is 17 * 3?',
              lambda calls, text='': not calls),
]

CODE_SYSTEM = ('You are a careful Python developer. Reply with one ```python code block holding the complete solution '
               '(standard library only), and nothing else after it.')
CODE_TASKS = [
    {'name': 'stake_rule', 'prompt': '''Write `stake_for(balance: float, won_last_on_pair: bool, real: bool) -> float`.
Rules: the stake is 5% of the balance, rounded DOWN to whole dollars, at least 1.0. On a real pair (real=True) right after a
win on that pair (won_last_on_pair=True) it is 18% of the balance rounded down to whole dollars instead (at least 1.0).
won_last_on_pair is ignored when real is False. Return a float.''',
     'tests': '''
assert stake_for(100, False, True) == 5.0
assert stake_for(130.9, False, False) == 6.0
assert stake_for(100, True, True) == 18.0
assert stake_for(100, True, False) == 5.0
assert stake_for(10, False, True) == 1.0
assert stake_for(3, True, True) == 1.0
assert isinstance(stake_for(250, True, True), float) and stake_for(250, True, True) == 45.0
'''},
    {'name': 'parse_close', 'prompt': r'''Pocket Option sends trade results as socket.io text frames like
451-["successcloseOrder",{"profit":4.6,"deals":[{"id":"a1","profit":4.6,"command":0},{"id":"b2","profit":-5,"command":1}]}]
Write `parse_close(frame: str) -> list[dict]` returning [{"id": ..., "profit": float, "direction": "buy"|"sell", "result": "win"|"loss"|"tie"}]
for each deal (command 0 is buy, 1 is sell; profit > 0 win, < 0 loss, 0 tie). Return [] for any other event name, for frames
without the JSON array, or for malformed JSON. The numeric prefix (here 451-) can be any digits followed by "-" or be absent.''',
     'tests': r'''
f = '451-["successcloseOrder",{"profit":4.6,"deals":[{"id":"a1","profit":4.6,"command":0},{"id":"b2","profit":-5,"command":1}]}]'
r = parse_close(f)
assert r == [{"id": "a1", "profit": 4.6, "direction": "buy", "result": "win"}, {"id": "b2", "profit": -5.0, "direction": "sell", "result": "loss"}], r
assert parse_close('42["successcloseOrder",{"deals":[{"id":"z","profit":0,"command":1}]}]') == [{"id": "z", "profit": 0.0, "direction": "sell", "result": "tie"}]
assert parse_close('["successcloseOrder",{"deals":[]}]') == []
assert parse_close('451-["updateStream",{"deals":[{"id":"x","profit":1,"command":0}]}]') == []
assert parse_close('2') == []
assert parse_close('451-["successcloseOrder",{bad json') == []
'''},
    {'name': 'fix_streak', 'prompt': '''This function should count the losses in a row at the END of a list of results
("win", "loss", "tie"); a tie neither breaks nor extends the streak (it is skipped). It has bugs. Return the fixed function.

def losing_streak(results):
    count = 0
    for r in results:
        if r == "loss":
            count += 1
        else:
            count = 0
    return count''',
     'tests': '''
assert losing_streak([]) == 0
assert losing_streak(["win", "loss", "loss"]) == 2
assert losing_streak(["loss", "loss", "win"]) == 0
assert losing_streak(["loss", "tie", "loss"]) == 2
assert losing_streak(["win", "loss", "tie"]) == 1
assert losing_streak(["tie", "tie"]) == 0
'''},
    {'name': 'expiry_rule', 'prompt': '''Write `snap_expiry(seconds: int, real: bool) -> int` for trade lengths.
OTC (real=False): clamp to 5..30 seconds. Real pairs: at least 60 seconds, at most 300, snapped to the nearest of the presets
60, 180, 300 (a tie goes to the shorter one).''',
     'tests': '''
assert snap_expiry(3, False) == 5 and snap_expiry(11, False) == 11 and snap_expiry(45, False) == 30
assert snap_expiry(11, True) == 60 and snap_expiry(660, True) == 300
assert snap_expiry(100, True) == 60 and snap_expiry(150, True) == 180 and snap_expiry(120, True) == 60
assert snap_expiry(240, True) == 180 and snap_expiry(241, True) == 300
'''},
    {'name': 'rsi', 'prompt': '''Write `rsi(closes: list[float], period: int = 14) -> float | None` using Wilder's smoothing:
the first average gain/loss is the simple mean of the first `period` changes, then avg = (avg * (period - 1) + current) / period
for each later change. Return None if there are fewer than period + 1 closes. If the average loss is 0 return 100.0.
Round to 2 decimals.''',
     'tests': '''
import random
def ref(c, p=14):
    if len(c) < p + 1: return None
    ch = [b - a for a, b in zip(c, c[1:])]
    g = sum(max(x, 0) for x in ch[:p]) / p; l = sum(max(-x, 0) for x in ch[:p]) / p
    for x in ch[p:]:
        g = (g * (p - 1) + max(x, 0)) / p; l = (l * (p - 1) + max(-x, 0)) / p
    return 100.0 if l == 0 else round(100 - 100 / (1 + g / l), 2)
random.seed(7)
for n in (15, 20, 60):
    c = [1.1 + random.uniform(-0.01, 0.01) for _ in range(n)]
    assert rsi(c) == ref(c), (rsi(c), ref(c))
assert rsi([1.0] * 10) is None
assert rsi([float(i) for i in range(20)]) == 100.0
c = [1.1 + random.uniform(-0.01, 0.01) for _ in range(30)]
assert rsi(c, 5) == ref(c, 5)
'''},
]


def chat(messages, tools=None):
    body = {'model': model, 'messages': messages, 'temperature': 0.3, 'max_tokens': 6000}
    if tools:
        body['tools'] = tools
    req = urllib.request.Request(base + '/chat/completions', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    started = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.loads(r.read())
    return data, time.time() - started


def run_code(code, tests):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / 'sol.py'
        p.write_text(code + '\n\n' + tests + '\nprint("PASS")\n', encoding='utf-8')
        try:
            done = subprocess.run([sys.executable, '-I', str(p)], capture_output=True, text=True, timeout=20, cwd=d)
        except subprocess.TimeoutExpired:
            return False, 'timeout'
        return 'PASS' in done.stdout, (done.stderr or done.stdout).strip()[-300:]


results = []
for i in range(runs):
    for t in TOOL_TASKS:
        try:
            data, secs = chat([{'role': 'system', 'content': SYSTEM_TOOLS}, {'role': 'user', 'content': t['prompt']}], TOOLS)
            msg = data['choices'][0]['message']
            calls = []
            bad_json = False
            for c in msg.get('tool_calls') or []:
                try:
                    calls.append((c['function']['name'], json.loads(c['function']['arguments'] or '{}')))
                except ValueError:
                    bad_json = True
            ok = (not bad_json) and bool(t['check'](calls))
            detail = calls if calls else (msg.get('content') or '')[:200]
            toks = (data.get('usage') or {}).get('completion_tokens') or 0
        except Exception as e:
            ok, detail, secs, toks = False, f'error: {e}', 0, 0
        results.append({'run': i, 'task': t['name'], 'kind': 'tool', 'ok': ok, 'secs': round(secs, 1), 'tokens': toks, 'detail': str(detail)[:300]})
        print(label, i, t['name'], ok, round(secs, 1), flush=True)
    for t in CODE_TASKS:
        try:
            data, secs = chat([{'role': 'system', 'content': CODE_SYSTEM}, {'role': 'user', 'content': t['prompt']}])
            text = data['choices'][0]['message'].get('content') or ''
            blocks = re.findall(r'```(?:python|py)?\s*\n(.*?)```', text, re.S)
            code = blocks[-1] if blocks else text
            ok, detail = run_code(code, t['tests'])
            toks = (data.get('usage') or {}).get('completion_tokens') or 0
        except Exception as e:
            ok, detail, secs, toks = False, f'error: {e}', 0, 0
        results.append({'run': i, 'task': t['name'], 'kind': 'code', 'ok': ok, 'secs': round(secs, 1), 'tokens': toks, 'detail': detail})
        print(label, i, t['name'], ok, round(secs, 1), flush=True)

Path(out).write_text(json.dumps({'label': label, 'model': model, 'results': results}, indent=1), encoding='utf-8')
print('saved', out)
