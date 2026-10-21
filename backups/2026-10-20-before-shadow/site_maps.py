"""Site maps kept as Obsidian notes: one folder per site, the permanent record.

<root>/<Site>/<Site>.md          overview: hosts, start page, everything mapped
<root>/<Site>/Targets/<name>.md  one taught button, menu or area (picture, history)
<root>/<Site>/Routines/<name>.md one replayable routine (readable steps, fill-ins)
<root>/<Site>/images/            reference crops shown in the notes

Each note carries its machine data in the JSON block under "## Data"; the rest
is written for people and rebuilt on every save. Sites are never merged: a
target keeps the page it was taught on, and a re-taught target keeps its old
version under history, so a changed layout is re-mapped without losing the old.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from procedure_memory import page_context

DEFAULT_ROOT = Path(__file__).parent.parent / 'data' / 'site-maps'
DATA = re.compile(r'## Data\s*```json\s*(\{.*?\})\s*```', re.S)
FRONT = re.compile(r'\A---\n(.*?)\n---\n', re.S)
UNSAFE = re.compile(r'[\\/:*?"<>|#^\[\]]+')
HISTORY = 10


def root_dir() -> Path:
    return Path(os.environ.get('LOCALTOOLS_SITE_MAPS') or DEFAULT_ROOT)


def host_of(url: str) -> str:
    host = (urlsplit(url).hostname or '').lower()
    return host[4:] if host.startswith('www.') else host


def page_of(url: str) -> str:
    return urlsplit(url).path or '/'


def key(name: str) -> str:
    return re.sub(r'[\W_]', '', (name or '').casefold())


def file_name(name: str) -> str:
    cleaned = ' '.join(UNSAFE.sub(' ', name).split()).strip(' .')
    return (cleaned or 'unnamed')[:80]


def default_site_name(host: str) -> str:
    parts = [p for p in host.split('.') if p not in ('m', 'app', 'www')]
    base = parts[-2] if len(parts) >= 2 else (parts[0] if parts else host)
    return base[:1].upper() + base[1:]


def read_data(path: Path) -> dict | None:
    try:
        match = DATA.search(path.read_text(encoding='utf-8'))
        return json.loads(match.group(1)) if match else None
    except (OSError, ValueError):
        return None


def front_matter(fields: dict) -> str:
    lines = ['---']
    for name, value in fields.items():
        if isinstance(value, list):
            lines.append(f'{name}:')
            lines += [f'  - {json.dumps(str(v))}' for v in value]
        elif value is not None and value != '':
            lines.append(f'{name}: {json.dumps(value) if isinstance(value, str) else value}')
    return '\n'.join(lines + ['---', ''])


def when(stamp) -> str:
    return time.strftime('%Y-%m-%d %H:%M', time.localtime(stamp)) if stamp else ''


def write_note(path: Path, fields: dict, body: str, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = front_matter(fields) + body.rstrip() + '\n\n## Data\n\n```json\n' + json.dumps(data, indent=1) + '\n```\n'
    temp = path.with_suffix('.tmp')
    temp.write_text(text, encoding='utf-8')
    # Obsidian (or a sync tool) can hold a note for a moment after it changes.
    for attempt in range(20):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.1)


def describe_step(step: dict) -> str:
    what = step.get('target') or (step.get('descriptor') or {}).get('label') or 'the element'
    do = step.get('do')
    if do == 'open':
        return f'Open {step.get("url")}'
    if do == 'click':
        return f'Click **{what}**'
    if do == 'type':
        return f'Type `{step.get("text", "")}` into **{what}**' + (' and press Enter' if step.get('submit') else '')
    if do == 'key':
        return f'Press {step.get("key")}'
    if do == 'menu_pick':
        return f'In menu **{what}**, pick `{step.get("label", "")}`'
    if do == 'wait_text':
        return f'Wait until `{step.get("text", "")}` shows'
    if do == 'wait':
        return f'Wait {step.get("seconds", 1)}s'
    return json.dumps(step)


class SiteMaps:
    """The vault store. Drop-in for the old SQLite target store's methods."""

    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root else root_dir()
        self.root.mkdir(parents=True, exist_ok=True)

    # Sites -----------------------------------------------------------------
    def sites(self) -> list[dict]:
        found = []
        for folder in sorted(p for p in self.root.iterdir() if p.is_dir()):
            data = read_data(folder / f'{folder.name}.md')
            if data:
                found.append({**data, 'folder': folder.name})
        return found

    def site_for(self, url: str, create: bool = False) -> dict | None:
        host = host_of(url)
        if not host:
            return None
        for site in self.sites():
            if any(host == h or host.endswith('.' + h) for h in site.get('hosts', [])):
                return site
        if not create:
            return None
        name = default_site_name(host)
        while (self.root / file_name(name)).exists():
            name += ' 2'
        parts = urlsplit(url)
        site = {'name': name, 'hosts': [host], 'start_url': f'{parts.scheme}://{parts.netloc}{parts.path or "/"}',
                'created_at': time.time(), 'folder': file_name(name)}
        self.write_site(site)
        return site

    def site_named(self, name: str) -> dict:
        wanted = key(name)
        for site in self.sites():
            if wanted in (key(site['name']), key(site['folder'])) or any(wanted == key(h) or wanted == key(h.split('.')[0]) for h in site.get('hosts', [])):
                return site
        raise LookupError(f'No mapped site called "{name}". Mapped: {", ".join(s["name"] for s in self.sites()) or "none yet"}.')

    def folder(self, site: dict) -> Path:
        return self.root / site['folder']

    def write_site(self, site: dict) -> None:
        folder = self.folder(site)
        targets, routines = self.site_targets(site), self.routines(site)
        lines = [f'# {site["name"]}', '', f'Start page: {site.get("start_url", "")}', '',
                 f'Addresses: {", ".join(site.get("hosts", []))}', '']
        if site.get('notes'):
            lines += [site['notes'], '']
        by_page: dict[str, list] = {}
        for t in targets:
            by_page.setdefault(t.get('page', '/'), []).append(t)
        lines += ['## Buttons and areas', '']
        if not targets:
            lines.append('Nothing taught yet.')
        for page, items in sorted(by_page.items()):
            lines += [f'### {page}', '']
            for t in sorted(items, key=lambda t: t['name'].casefold()):
                flag = ' (needs re-teaching)' if t.get('status') == 'needs_reteach' else ''
                lines.append(f'- [[{t["note"]}|{t["name"]}]]: {t["kind"]}{flag}')
            lines.append('')
        lines += ['## Routines', '']
        if not routines:
            lines.append('No routines yet.')
        for r in routines:
            fills = f' (fill in: {", ".join(r.get("params", []))})' if r.get('params') else ''
            lines.append(f'- [[{r["note"]}|{r["name"]}]]{fills}: {r.get("description", "")}')
        data = {k: v for k, v in site.items() if k != 'folder'}
        data['updated_at'] = time.time()
        write_note(folder / f'{site["folder"]}.md',
                   {'site': site['name'], 'start': site.get('start_url', ''), 'hosts': site.get('hosts', []),
                    'buttons': len(targets), 'routines': len(routines), 'updated': when(data['updated_at']),
                    'tags': ['site-map']},
                   '\n'.join(lines), data)

    def rename_site(self, name: str, new_name: str, start_url: str = '') -> dict:
        site = self.site_named(name)
        if new_name and file_name(new_name) != site['folder']:
            target = self.root / file_name(new_name)
            old = self.folder(site)
            same = target.exists() and os.path.samefile(target, old)  # Windows: only the capitals change.
            if target.exists() and not same:
                raise ValueError(f'A site folder called "{file_name(new_name)}" already exists.')
            (old / f'{site["folder"]}.md').rename(old / f'{file_name(new_name)}.md')
            if same:
                old = old.rename(old.with_name(old.name + '.renaming'))
            old.rename(target)
            site['folder'] = file_name(new_name)
        site['name'] = new_name or site['name']
        if start_url:
            site['start_url'] = start_url
        self.write_site(site)
        return site

    # Targets ---------------------------------------------------------------
    def site_targets(self, site: dict) -> list[dict]:
        out = []
        for path in sorted((self.folder(site) / 'Targets').glob('*.md')):
            data = read_data(path)
            if data:
                out.append({**data, 'note': f'Targets/{path.stem}'})
        return out

    def _target_path(self, site: dict, record: dict) -> Path:
        base = self.folder(site) / 'Targets'
        for path in base.glob('*.md'):
            if (read_data(path) or {}).get('id') == record['id']:
                return path
        name = file_name(record['name'])
        others = [t for t in self.site_targets(site) if key(t['name']) == key(record['name']) and t['id'] != record['id']]
        if others:
            name = file_name(f'{record["name"]} ({record.get("page", "/").strip("/") or "home"})')
        path, n = base / f'{name}.md', 2
        while path.exists():
            path, n = base / f'{name} {n}.md', n + 1
        return path

    def _image(self, site: dict, source) -> str | None:
        if not source:
            return None
        source = Path(source)
        if not source.exists():
            return None
        folder = self.folder(site) / 'images'
        folder.mkdir(parents=True, exist_ok=True)
        if source.parent != folder:
            shutil.copy2(source, folder / source.name)
        return source.name

    def save_target(self, value: dict) -> dict:
        url = value.get('url') or value.get('context') or ''
        site = self.site_for(url, create=True)
        if site is None:
            raise ValueError('Targets are saved for an HTTP(S) page.')
        value['updated_at'] = time.time()
        value.setdefault('page', page_of(url))
        value['site'] = site['name']
        # Re-teaching a name on the same page keeps the old version as history.
        same = [t for t in self.site_targets(site) if t['id'] != value['id'] and key(t['name']) == key(value['name'])
                and t.get('page') == value['page']]
        history = []
        for old in same:
            history = old.get('history', []) + [{k: v for k, v in old.items() if k not in ('history', 'note')}]
            value['id'] = old['id']
        if same or value.get('history'):
            value['history'] = (value.get('history', []) + history)[-HISTORY:]
        value['image'] = self._image(site, value.get('reference_image')) or value.get('image')
        value.pop('note', None)
        value.pop('elsewhere', None)
        path = self._target_path(site, value)
        d = value.get('descriptor') or {}
        body = [f'# {value["name"]}', '', f'Site: [[{site["folder"]}]] · page `{value["page"]}` · {value.get("kind", "button")}', '']
        if value.get('image'):
            body += [f'![[{value["image"]}]]', '']
        body += [f'- Element: `{d.get("tag", "")}` labelled "{d.get("label", "")}"',
                 f'- Status: {value.get("status", "")}', f'- Taught: {when(value.get("created_at") or value["updated_at"])}']
        if value.get('expected_text'):
            body.append(f'- Expect after clicking: "{value["expected_text"]}"')
        if value.get('last_used'):
            body.append(f'- Last found on the page: {when(value["last_used"])}')
        if value.get('history'):
            body += ['', '## Earlier versions', '']
            body += [f'- {when(h.get("updated_at"))}: `{(h.get("descriptor") or {}).get("tag", "")}` "{(h.get("descriptor") or {}).get("label", "")}"'
                     for h in reversed(value['history'])]
        value.setdefault('created_at', value['updated_at'])
        write_note(path, {'site': site['name'], 'kind': value.get('kind', 'button'), 'page': value['page'],
                          'status': value.get('status', ''), 'updated': when(value['updated_at']), 'tags': ['site-map/target']},
                   '\n'.join(body), value)
        self.write_site(site)
        return {**value, 'note': f'Targets/{path.stem}'}

    def list_targets(self, url: str) -> list[dict]:
        """Targets for this page first, then the site's others by name not taught here."""
        site = self.site_for(url)
        if not site:
            return []
        page = page_of(url)
        everything = self.site_targets(site)
        here = [t for t in everything if t.get('page') == page]
        names = {key(t['name']) for t in here}
        elsewhere = [{**t, 'elsewhere': True} for t in everything if t.get('page') != page and key(t['name']) not in names]
        return here + elsewhere

    def candidates(self, identity: str, url: str) -> list[dict]:
        """Records an ID or name may mean: this page's first, then other pages'."""
        records = self.list_targets(url)
        by_id = [r for r in records if r['id'] == identity]
        if by_id:
            return by_id
        wanted = key(identity)
        return [r for r in records if wanted and key(r['name']) == wanted and r.get('status') != 'needs_reteach']

    def get_target(self, identity: str, url: str) -> dict:
        found = self.candidates(identity, url)
        here = [r for r in found if not r.get('elsewhere')]
        if len(here) == 1 or (not here and len(found) == 1):
            return (here or found)[0]
        if len(here) > 1:
            raise LookupError('Saved target name is ambiguous on this page. Use a target ID from browser_targets.')
        if found:
            raise LookupError('This name was taught on several other pages of the site; teach it on this page.')
        raise LookupError('Taught target is not saved for this site. Use browser_targets for saved names; teach missing targets.')

    def forget_target(self, identity: str, url: str) -> bool:
        site = self.site_for(url)
        if not site:
            return False
        for path in (self.folder(site) / 'Targets').glob('*.md'):
            data = read_data(path)
            if data and (data['id'] == identity or (key(data['name']) == key(identity) and data.get('page') == page_of(url))):
                path.unlink()
                self.write_site(site)
                return True
        return False

    def touch_target(self, record: dict, url: str) -> None:
        """Note that a target was found on the page (shown in its note)."""
        if time.time() - record.get('last_used', 0) > 3600:
            record = {k: v for k, v in record.items() if k not in ('elsewhere', 'note')}
            record['last_used'] = time.time()
            record.setdefault('url', url)
            self.save_target(record)

    # Routines --------------------------------------------------------------
    def routines(self, site: dict) -> list[dict]:
        out = []
        for path in sorted((self.folder(site) / 'Routines').glob('*.md')):
            data = read_data(path)
            if data:
                out.append({**data, 'note': f'Routines/{path.stem}'})
        return out

    def routine(self, site: dict, name: str) -> dict:
        wanted = key(name)
        for r in self.routines(site):
            if key(r['name']) == wanted:
                return r
        raise LookupError(f'No routine "{name}" on {site["name"]}. Routines: {", ".join(r["name"] for r in self.routines(site)) or "none yet"}.')

    def save_routine(self, site: dict, value: dict) -> dict:
        value.setdefault('id', str(uuid.uuid4()))
        value.setdefault('created_at', time.time())
        value['updated_at'] = time.time()
        value['site'] = site['name']
        base = self.folder(site) / 'Routines'
        path = base / f'{file_name(value["name"])}.md'
        for existing in base.glob('*.md'):
            old = read_data(existing)
            if old and (old['id'] == value['id'] or key(old['name']) == key(value['name'])):
                path = existing
                if old['id'] != value['id'] or old.get('steps') != value.get('steps'):
                    value['history'] = (old.get('history', []) + [{k: v for k, v in old.items() if k not in ('history', 'note')}])[-HISTORY:]
                value['id'] = old['id']
        value.pop('note', None)
        body = [f'# {value["name"]}', '', f'Site: [[{site["folder"]}]]', '']
        if value.get('description'):
            body += [value['description'], '']
        if value.get('params'):
            body += [f'Fill-ins: {", ".join("`{" + p + "}`" for p in value["params"])}', '']
        body += ['## Steps', '']
        body += [f'{i}. {describe_step(s)}' for i, s in enumerate(value.get('steps', []), 1)]
        if value.get('last_run'):
            run = value['last_run']
            body += ['', f'Last run: {when(run.get("at"))}, {run.get("result")}' + (f' at step {run["step"]}' if run.get('step') else '')]
        write_note(path, {'site': site['name'], 'params': value.get('params', []), 'steps': len(value.get('steps', [])),
                          'updated': when(value['updated_at']), 'tags': ['site-map/routine']}, '\n'.join(body), value)
        self.write_site(site)
        return {**value, 'note': f'Routines/{path.stem}'}

    def forget_routine(self, site: dict, name: str) -> bool:
        wanted = key(name)
        for path in (self.folder(site) / 'Routines').glob('*.md'):
            data = read_data(path)
            if data and key(data['name']) == wanted:
                path.unlink()
                self.write_site(site)
                return True
        return False

    def summary(self) -> list[dict]:
        out = []
        for site in self.sites():
            out.append({'name': site['name'], 'start_url': site.get('start_url', ''), 'hosts': site.get('hosts', []),
                        'targets': sorted({t['name'] for t in self.site_targets(site)}),
                        'routines': [{'name': r['name'], 'params': r.get('params', []), 'description': r.get('description', '')}
                                     for r in self.routines(site)]})
        return out


def migrate_sqlite(store: SiteMaps, sqlite_path: Path, image_dirs: list[Path]) -> int:
    """Copy targets from the old SQLite store into the vault (the file is left as is)."""
    import sqlite3
    if not sqlite_path.exists():
        return 0
    db = sqlite3.connect(str(sqlite_path))
    try:
        rows = db.execute("SELECT data FROM browser_targets").fetchall()
    except sqlite3.Error:
        return 0
    finally:
        db.close()
    moved = 0
    for (raw,) in rows:
        record = json.loads(raw)
        if not record.get('context'):
            continue
        site = store.site_for(record['context'], create=True)
        if any(t['id'] == record['id'] for t in store.site_targets(site)):
            continue
        image = record.get('reference_image')
        if image and not Path(image).exists():
            for folder in image_dirs:
                if (folder / Path(image).name).exists():
                    record['reference_image'] = str(folder / Path(image).name)
                    break
        record['url'] = record['context']
        record['page'] = page_of(record['context'])
        store.save_target(record)
        moved += 1
    return moved
