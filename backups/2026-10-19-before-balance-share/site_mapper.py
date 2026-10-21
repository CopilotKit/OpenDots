"""Site mapping: teach a website once, then call it like an API.

Wraps the api-anything command line (https://github.com/goodnight000/api-anything,
built next to OpenDots): it loads a page in a browser, records the requests the
site's own frontend makes, and saves the one carrying the example inputs as a
reusable operation. The Dots call learned operations through api-anything's MCP
server (list_sites, list_operations, call_operation, login).

Writes are enabled (owner, 2026-10-19): operations that change state (submit,
order, post) can be learned with write=True and are called through
call_operation (the MCP server runs with --allow-writes). The owner keeps money
sites on demo/paper accounts; that rule is theirs to enforce, not the tools'.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

CLI = Path(os.environ.get('API_ANYTHING_CLI', Path(__file__).parent.parent.parent / 'api-anything' / 'dist' / 'cli.js'))
NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,40}$')
TIMEOUT = 240


def run(*args: str) -> dict:
    """Run one api-anything command and return its JSON (or its text)."""
    if not CLI.exists():
        raise FileNotFoundError(f'api-anything is not built at {CLI}; see docs/SITE-MAPPING.md.')
    done = subprocess.run(['node', str(CLI), *args], capture_output=True, text=True, encoding='utf-8',
                          errors='replace', timeout=TIMEOUT)
    out = (done.stdout or '').strip()
    try:
        result = json.loads(out)
    except ValueError:
        result = {'output': out[-6000:]}
    if done.returncode != 0:
        detail = (done.stderr or '').strip()[-1500:] or out[-1500:]
        raise RuntimeError(f'api-anything {args[0]} failed: {detail}')
    return result if isinstance(result, dict) else {'result': result}


def pairs(values: dict | None) -> list[str]:
    """{"query": "sqlite"} -> ["query=sqlite"] for --example."""
    return [f'{k}={v}' for k, v in (values or {}).items()]


def register(tool) -> None:
    @tool()
    def site_capture(url: str, example: dict | None = None, steps: list | None = None, write: bool = False) -> dict:
        """Map step 1: load a page and list the requests its frontend made, ranked
        (requests carrying the example values first) with a summary of the top
        ones. example: the input you typed or that is in the URL, e.g.
        {"query": "sqlite"}. steps: optional UI steps after load, e.g.
        [{"action": "fill", "selector": "#q", "value": "sqlite"}, {"action": "press",
        "value": "Enter"}]. write=True maps a submit or order button: requests that
        change state are recorded but stopped before they leave the browser, so
        mapping never sends them. Returns a capture id for site_inspect / site_add."""
        args = ['capture', url, '--outline'] + (['--write'] if write else [])
        for value in pairs(example):
            args += ['--example', value]
        if steps:
            args += ['--steps', json.dumps(steps)]
        return run(*args)

    @tool()
    def site_inspect(capture_id: str, request_id: str = '', extract: str = '', pick: str = '', html: str = '') -> dict:
        """Map step 2: look at one captured request and its response, and try the
        recipe before saving it: extract is a path into the response (e.g.
        "hits" or "sections[*].items"), pick the fields to keep (e.g. "title,url").
        For a server-rendered page, html is the list recipe the capture suggested,
        e.g. {"items": "li.result", "fields": {"title": "a.title", "url": "a.title@href"}}.
        Without request_id, lists every request in the capture."""
        args = ['inspect', capture_id] + ([request_id] if request_id else [])
        if html:
            args += ['--html', html if isinstance(html, str) else json.dumps(html)]
        if extract:
            args += ['--extract', extract]
        if pick:
            args += ['--pick', pick]
        return run(*args)

    @tool()
    def site_add(site: str, operation: str, trigger: str, example: dict, example2: dict | None = None,
                 extract: str = '', pick: str = '', html: str = '', from_capture: str = '', pick_request: str = '',
                 write: bool = False) -> dict:
        """Map step 3: save an operation. site/operation: short names
        (e.g. "books", "search"). trigger: the page URL with {param} slots, e.g.
        "https://site.com/search?q={query}". example / example2: two different
        inputs, e.g. {"query": "sqlite"} and {"query": "postgres"}; the request
        that changes with them is learned. write=True saves an operation that
        changes state (submit, order, post), e.g. from a site_capture(write=True).
        For a server-rendered page, pass the html list recipe (see site_inspect)."""
        if not NAME.match(site) or not NAME.match(operation):
            raise ValueError('site and operation must be short lowercase names (letters, digits, - or _).')
        args = ['add', site, operation, '--trigger', trigger] + (['--write'] if write else [])
        for value in pairs(example):
            args += ['--example', value]
        for value in pairs(example2):
            args += ['--example2', value]
        if extract:
            args += ['--extract', extract]
        if pick:
            args += ['--pick', pick]
        if html:
            args += ['--html', html if isinstance(html, str) else json.dumps(html)]
        if from_capture:
            args += ['--from', from_capture] + (['--pick-request', pick_request] if pick_request else [])
        return run(*args)

    @tool()
    def site_verify(site: str = '') -> dict:
        """Map step 4: call every read operation (of one site, or all) with its
        stored examples, repairing any that broke. Use after mapping a site and
        before relying on it."""
        return run('verify', *([site] if site else []))

    @tool()
    def site_list(site: str = '') -> dict:
        """The mapped sites, or one site's operations with their inputs and outputs."""
        return run('ops', site) if site else run('sites')
