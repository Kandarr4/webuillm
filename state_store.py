"""
state_store.py — хранилище состояния локальной обработки (SQLite).

Раньше всё состояние лежало в local_state.json и переписывалось целиком после
каждой смены статуса: на 1231 записи это 589 КБ на файл, то есть сотни полных
перезаписей за прогон пакета. Здесь то же состояние разложено по таблицам и
пишется построчно — смена статуса одного файла трогает одну строку.

В памяти LocalProcessor продолжает держать прежний словарь state (его читает
status_summary и рабочий цикл); хранилище отвечает только за запись и чтение
при старте.

Таблицы:
    files   — по строке на аудиофайл, ключ "<пакет>/<путь внутри пакета>"
    recent  — лента последних событий (обрезается до лимита)
    meta    — конфигурация и рантайм-флаги, значения в JSON

При первом запуске состояние переносится из local_state.json, если он есть.
Сам json не удаляется и больше не пишется — остаётся резервной копией.
"""

import json
import os
import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    key            TEXT PRIMARY KEY,
    package        TEXT NOT NULL,
    rel_path       TEXT NOT NULL,
    name           TEXT NOT NULL,
    f_id           TEXT,
    status         TEXT NOT NULL,
    txt_path       TEXT,
    duration       REAL,
    max_volume_db  REAL,
    mean_volume_db REAL,
    error          TEXT,
    stream_retries INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS files_status  ON files(status);
CREATE INDEX IF NOT EXISTS files_package ON files(package);

CREATE TABLE IF NOT EXISTS recent (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT,
    status  TEXT,
    message TEXT,
    ts      TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
);
"""

# Поля записи файла в том же порядке, что и колонки таблицы.
FILE_FIELDS = ('package', 'rel_path', 'name', 'f_id', 'status', 'txt_path',
               'duration', 'max_volume_db', 'mean_volume_db', 'error',
               'stream_retries', 'updated_at')

DEFAULT_CONFIG_KEYS = ('input_dir', 'model', 'prompt')


def file_key(rec):
    """Ключ записи — тот же, что был ключом словаря files в json."""
    return f"{rec['package']}/{rec['rel_path']}"


class StateStore:
    def __init__(self, db_path, logger=None):
        self.path = db_path
        self.log = logger
        # Пишут и рабочий поток, и потоки запросов Flask — отсюда общий замок и
        # check_same_thread=False. WAL, чтобы чтение статуса не ждало записи.
        self._lock = threading.Lock()
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.executescript(SCHEMA)
            self._db.commit()

    def _info(self, m):
        if self.log:
            self.log.info(f"[state] {m}")

    def _error(self, m):
        if self.log:
            self.log.error(f"[state] {m}")

    def close(self):
        with self._lock:
            self._db.close()

    # ── чтение при старте ────────────────────────────────────────────────────
    def load(self, defaults):
        """Собрать состояние в прежней форме словаря.

        running/current намеренно сбрасываются: если сервер упал в процессе,
        обработка после перезапуска не идёт, а файлы «в работе» возвращаются
        в очередь.
        """
        with self._lock:
            rows = self._db.execute("SELECT * FROM files").fetchall()
            recent = self._db.execute(
                "SELECT name, status, message, ts FROM recent ORDER BY id DESC").fetchall()
            meta = {r['k']: r['v'] for r in self._db.execute("SELECT k, v FROM meta")}

        files = {}
        for r in rows:
            rec = {f: r[f] for f in FILE_FIELDS}
            if rec['status'] in ('processing', 'analyzing', 'transcribing'):
                rec['status'] = 'pending'
            files[r['key']] = rec

        config = dict(defaults['config'])
        for k in DEFAULT_CONFIG_KEYS:
            if 'config.' + k in meta:
                config[k] = json.loads(meta['config.' + k])

        return {
            'running': False,
            'started_at': json.loads(meta['started_at']) if 'started_at' in meta else None,
            'current': None,
            'recent': [dict(r) for r in recent],
            'files': files,
            'config': config,
        }

    def is_empty(self):
        with self._lock:
            n = self._db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
            m = self._db.execute("SELECT COUNT(*) FROM meta").fetchone()[0]
        return n == 0 and m == 0

    # ── запись ───────────────────────────────────────────────────────────────
    def save_file(self, rec):
        """Одна запись файла — одна строка."""
        self.save_files([rec])

    def save_files(self, recs):
        """Пакетная запись — одна транзакция на всё (используется сканированием)."""
        rows = [(file_key(r),) + tuple(r.get(f) for f in FILE_FIELDS) for r in recs]
        if not rows:
            return
        cols = ', '.join(('key',) + FILE_FIELDS)
        marks = ', '.join('?' * (len(FILE_FIELDS) + 1))
        try:
            with self._lock:
                self._db.executemany(
                    f"INSERT INTO files ({cols}) VALUES ({marks}) "
                    f"ON CONFLICT(key) DO UPDATE SET "
                    + ', '.join(f"{f}=excluded.{f}" for f in FILE_FIELDS),
                    rows)
                self._db.commit()
        except Exception as e:
            self._error(f"не удалось сохранить записи файлов: {e}")

    def push_recent(self, entry, limit):
        """Добавить событие в ленту и обрезать её до лимита."""
        try:
            with self._lock:
                self._db.execute(
                    "INSERT INTO recent (name, status, message, ts) VALUES (?, ?, ?, ?)",
                    (entry.get('name'), entry.get('status'), entry.get('message'), entry.get('ts')))
                self._db.execute(
                    "DELETE FROM recent WHERE id NOT IN "
                    "(SELECT id FROM recent ORDER BY id DESC LIMIT ?)", (limit,))
                self._db.commit()
        except Exception as e:
            self._error(f"не удалось записать событие: {e}")

    def save_meta(self, pairs):
        """pairs — словарь {ключ: значение}; значения кладутся в JSON."""
        try:
            with self._lock:
                self._db.executemany(
                    "INSERT INTO meta (k, v) VALUES (?, ?) "
                    "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                    [(k, json.dumps(v, ensure_ascii=False)) for k, v in pairs.items()])
                self._db.commit()
        except Exception as e:
            self._error(f"не удалось сохранить настройки: {e}")

    def save_config(self, config):
        self.save_meta({'config.' + k: config.get(k) for k in DEFAULT_CONFIG_KEYS})

    # ── перенос из старого json ──────────────────────────────────────────────
    def migrate_from_json(self, json_path, recent_limit):
        """Однократный перенос local_state.json в базу. True — если перенесли."""
        if not os.path.exists(json_path) or not self.is_empty():
            return False
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            self._error(f"не удалось прочитать {os.path.basename(json_path)}: {e}")
            return False

        files = data.get('files') or {}
        recs = []
        for key, rec in files.items():
            if not isinstance(rec, dict):
                continue
            # Ключ в json — «<пакет>/<rel_path>»; если полей нет, берём из ключа.
            r = dict(rec)
            if not r.get('package') or not r.get('rel_path'):
                package, _, rel = key.partition('/')
                r.setdefault('package', package)
                r.setdefault('rel_path', rel)
            r.setdefault('name', os.path.basename(r['rel_path']))
            r.setdefault('status', 'pending')
            r.setdefault('stream_retries', 0)
            recs.append(r)

        self.save_files(recs)
        for entry in reversed((data.get('recent') or [])[:recent_limit]):
            self.push_recent(entry, recent_limit)
        cfg = data.get('config') or {}
        if cfg:
            self.save_config(cfg)
        if data.get('started_at'):
            self.save_meta({'started_at': data['started_at']})

        self._info(f"Перенос из {os.path.basename(json_path)}: {len(recs)} файлов, "
                   f"{len(data.get('recent') or [])} событий. Файл оставлен как резервная копия.")
        return True
