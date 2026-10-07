"""
app_db.py — база приложения: пользователи, сессии, чаты и сообщения.

Отдельна от local_state.db (очередь пакетной обработки): у той свой жизненный
цикл, её можно потерять без последствий, а здесь лежат учётные записи и
переписка.

Пароли хранятся хэшами (werkzeug, scrypt) — Werkzeug и так приходит с Flask,
своей криптографии не пишем. Токен сессии в базе тоже лежит хэшем: утечка
файла базы не должна давать готовые ключи от чужих сессий.
"""

import datetime
import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import threading

from werkzeug.security import check_password_hash, generate_password_hash

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL,
    username_low  TEXT NOT NULL UNIQUE,   -- вход без учёта регистра
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_user ON chats(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    stats      TEXT                       -- JSON: токены и скорость ответа модели
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
"""

USERNAME_RE = re.compile(r'^[A-Za-z0-9._-]{3,32}$')
MIN_PASSWORD = 8
SESSION_DAYS = 30
TITLE_LIMIT = 60

# Что из статистики ответа храним: токены запроса/ответа/кэша и скорости
# (генерация и обработка промпта, ток/с); у расшифровки аудио — длина записи
# и время распознавания (с) и их отношение rtf. Остальное от клиента
# отбрасываем.
STATS_KEYS = ('prompt', 'completion', 'cached', 'tps', 'pps', 'audio', 'infer', 'rtf')


class AuthError(Exception):
    """Ошибка, которую можно показать пользователю как есть."""


def _now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def _iso(dt):
    return dt.isoformat()


def _hash_token(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def clean_stats(stats):
    """Только известные числовые поля; пусто — None."""
    if not isinstance(stats, dict):
        return None
    out = {}
    for k in STATS_KEYS:
        v = stats.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0:
            out[k] = round(v, 2)
    return out or None


def make_title(text):
    """Заголовок чата из первой реплики."""
    t = ' '.join((text or '').split())
    if not t:
        return 'Новый чат'
    return t[:TITLE_LIMIT] + ('…' if len(t) > TITLE_LIMIT else '')


class AppDB:
    def __init__(self, db_path, logger=None):
        self.path = db_path
        self.log = logger
        self._lock = threading.Lock()
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.executescript(SCHEMA)
            # Базы, заведённые до появления статистики, — дописать колонку.
            cols = {r['name'] for r in self._db.execute("PRAGMA table_info(messages)")}
            if 'stats' not in cols:
                self._db.execute("ALTER TABLE messages ADD COLUMN stats TEXT")
            self._db.commit()

    def close(self):
        with self._lock:
            self._db.close()

    # ── пользователи ─────────────────────────────────────────────────────────
    def user_count(self):
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM users").fetchone()[0]

    def create_user(self, username, password):
        username = (username or '').strip()
        if not USERNAME_RE.match(username):
            raise AuthError('Имя: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание')
        if len(password or '') < MIN_PASSWORD:
            raise AuthError(f'Пароль короче {MIN_PASSWORD} символов')
        row = (username, username.lower(), generate_password_hash(password), _iso(_now()))
        try:
            with self._lock:
                cur = self._db.execute(
                    "INSERT INTO users (username, username_low, password_hash, created_at) "
                    "VALUES (?, ?, ?, ?)", row)
                self._db.commit()
                uid = cur.lastrowid
        except sqlite3.IntegrityError:
            raise AuthError('Такое имя уже занято')
        return {'id': uid, 'username': username}

    def verify_user(self, username, password):
        with self._lock:
            r = self._db.execute(
                "SELECT id, username, password_hash FROM users WHERE username_low = ?",
                ((username or '').strip().lower(),)).fetchone()
        # Хэш считаем даже для несуществующего имени: иначе по времени ответа
        # видно, какие имена заняты.
        stored = r['password_hash'] if r else generate_password_hash('-')
        ok = check_password_hash(stored, password or '')
        if not r or not ok:
            return None
        return {'id': r['id'], 'username': r['username']}

    # ── сессии ───────────────────────────────────────────────────────────────
    def create_session(self, user_id, days=SESSION_DAYS):
        token = secrets.token_urlsafe(32)
        now = _now()
        with self._lock:
            self._db.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) "
                "VALUES (?, ?, ?, ?)",
                (_hash_token(token), user_id, _iso(now),
                 _iso(now + datetime.timedelta(days=days))))
            self._db.commit()
        return token

    def user_by_session(self, token):
        if not token:
            return None
        with self._lock:
            r = self._db.execute(
                "SELECT u.id, u.username, s.expires_at FROM sessions s "
                "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
                (_hash_token(token),)).fetchone()
        if not r:
            return None
        if r['expires_at'] < _iso(_now()):
            self.delete_session(token)
            return None
        return {'id': r['id'], 'username': r['username']}

    def delete_session(self, token):
        if not token:
            return
        with self._lock:
            self._db.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))
            self._db.commit()

    def purge_expired_sessions(self):
        with self._lock:
            cur = self._db.execute("DELETE FROM sessions WHERE expires_at < ?", (_iso(_now()),))
            self._db.commit()
            return cur.rowcount

    # ── чаты ─────────────────────────────────────────────────────────────────
    def list_chats(self, user_id):
        with self._lock:
            rows = self._db.execute(
                "SELECT c.id, c.title, c.created_at, c.updated_at, "
                "       (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messages "
                "FROM chats c WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.id DESC",
                (user_id,)).fetchall()
        return [dict(r) for r in rows]

    def create_chat(self, user_id, title=None):
        now = _iso(_now())
        t = (title or '').strip() or 'Новый чат'
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO chats (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (user_id, t[:TITLE_LIMIT + 1], now, now))
            self._db.commit()
            chat_id = cur.lastrowid
        return {'id': chat_id, 'title': t, 'created_at': now, 'updated_at': now, 'messages': 0}

    def _owned(self, user_id, chat_id):
        """Чат принадлежит пользователю? Любой доступ идёт только через эту проверку."""
        r = self._db.execute(
            "SELECT id FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id)).fetchone()
        return r is not None

    def get_chat(self, user_id, chat_id):
        with self._lock:
            if not self._owned(user_id, chat_id):
                return None
            chat = self._db.execute(
                "SELECT id, title, created_at, updated_at FROM chats WHERE id = ?",
                (chat_id,)).fetchone()
            msgs = self._db.execute(
                "SELECT id, role, content, created_at, stats FROM messages "
                "WHERE chat_id = ? ORDER BY id", (chat_id,)).fetchall()
        out = dict(chat)
        out['messages'] = []
        for m in msgs:
            d = dict(m)
            try:
                d['stats'] = json.loads(d['stats']) if d['stats'] else None
            except ValueError:
                d['stats'] = None
            out['messages'].append(d)
        return out

    def rename_chat(self, user_id, chat_id, title):
        t = (title or '').strip()
        if not t:
            raise AuthError('Пустое название')
        with self._lock:
            if not self._owned(user_id, chat_id):
                return None
            self._db.execute("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
                             (t[:TITLE_LIMIT + 1], _iso(_now()), chat_id))
            self._db.commit()
        return self.get_chat(user_id, chat_id)

    def delete_chat(self, user_id, chat_id):
        with self._lock:
            if not self._owned(user_id, chat_id):
                return False
            # foreign_keys=ON + ON DELETE CASCADE уносит сообщения.
            self._db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
            self._db.commit()
        return True

    def add_message(self, user_id, chat_id, role, content, stats=None):
        if role not in ('user', 'assistant', 'system'):
            raise AuthError('Неизвестная роль реплики')
        now = _iso(_now())
        stats = clean_stats(stats)
        with self._lock:
            if not self._owned(user_id, chat_id):
                return None
            cur = self._db.execute(
                "INSERT INTO messages (chat_id, role, content, created_at, stats) VALUES (?, ?, ?, ?, ?)",
                (chat_id, role, content or '', now,
                 json.dumps(stats) if stats else None))
            # Первая реплика пользователя даёт чату имя, если оно ещё дежурное.
            if role == 'user':
                self._db.execute(
                    "UPDATE chats SET title = CASE WHEN title = 'Новый чат' THEN ? ELSE title END, "
                    "updated_at = ? WHERE id = ?",
                    (make_title(content), now, chat_id))
            else:
                self._db.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (now, chat_id))
            self._db.commit()
            msg_id = cur.lastrowid
        return {'id': msg_id, 'role': role, 'content': content or '', 'created_at': now, 'stats': stats}

    def update_message(self, user_id, chat_id, msg_id, content):
        """Правка реплики. Метрики (скорость, токены) у правленого ответа уже
        не про этот текст — сбрасываем. None — нет такого чата или реплики."""
        now = _iso(_now())
        with self._lock:
            if not self._owned(user_id, chat_id):
                return None
            cur = self._db.execute(
                "UPDATE messages SET content = ?, stats = NULL WHERE id = ? AND chat_id = ?",
                (content or '', msg_id, chat_id))
            if cur.rowcount == 0:
                return None
            self._db.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (now, chat_id))
            self._db.commit()
            row = self._db.execute(
                "SELECT id, role, content, created_at FROM messages WHERE id = ?", (msg_id,)).fetchone()
        return dict(row, stats=None)

    def truncate_messages(self, user_id, chat_id, from_id):
        """Удаляет реплику from_id и всё, что после неё (перегенерация ответа,
        переотправка правленого вопроса). Возвращает число удалённых или None."""
        with self._lock:
            if not self._owned(user_id, chat_id):
                return None
            cur = self._db.execute(
                "DELETE FROM messages WHERE chat_id = ? AND id >= ?", (chat_id, from_id))
            self._db.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (_iso(_now()), chat_id))
            self._db.commit()
        return cur.rowcount
