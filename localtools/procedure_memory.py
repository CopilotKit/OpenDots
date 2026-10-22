"""Local, versioned browser procedures. Recall is advisory, never execution."""
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit


def page_context(url):
    value = urlsplit(url)
    if value.scheme not in ('http', 'https') or not value.hostname:
        return ''
    # Exclude credentials, query strings and fragments.
    port = f':{value.port}' if value.port else ''
    return f'{value.scheme}://{value.hostname}{port}{value.path or "/"}'


class ProcedureMemory:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS browser_procedures(id TEXT PRIMARY KEY, context TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, identity):
        with self.connect() as db:
            row = db.execute('SELECT data FROM browser_procedures WHERE id=?', (identity,)).fetchone()
        if not row:
            raise LookupError('Procedure not found')
        return json.loads(row[0])

    def save(self, value):
        value['updated_at'] = time.time()
        with self.connect() as db:
            db.execute('INSERT INTO browser_procedures VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated=excluded.updated',
                       (value['id'], value['context'], value['name'], value['status'], json.dumps(value), value['updated_at']))
        return value

    def begin(self, url, name, objective):
        context = page_context(url)
        if not context or not name.strip() or not objective.strip():
            raise ValueError('A current HTTP(S) page, procedure name and objective are required')
        return self.save({'id': str(uuid.uuid4()), 'context': context, 'name': name.strip()[:160], 'objective': objective.strip()[:2000], 'status': 'recording', 'steps': [], 'created_at': time.time(), 'recovery': 'Reacquire the target from the current page. Never replay uncertain actions or reuse stored coordinates blindly.'})

    def append(self, identity, step):
        value = self.get(identity)
        if value['status'] != 'recording':
            raise ValueError('Procedure is no longer recording')
        value['steps'].append({'number': len(value['steps']) + 1, **step})
        self.save(value)

    def finish(self, identity):
        value = self.get(identity)
        if value['status'] != 'recording':
            return value
        value['status'] = 'verified' if value['steps'] and all(step['verification'] == 'passed' for step in value['steps']) else 'needs_review'
        return self.save(value)

    def recall(self, url):
        with self.connect() as db:
            rows = db.execute('SELECT data FROM browser_procedures WHERE context=? ORDER BY updated DESC LIMIT 5', (page_context(url),)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def delete(self, identity):
        with self.connect() as db:
            return db.execute('DELETE FROM browser_procedures WHERE id=?', (identity,)).rowcount > 0
