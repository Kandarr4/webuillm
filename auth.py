"""
auth.py — вход, регистрация и защита маршрутов.

Сессия — случайный токен в httponly-куке; в базе от него лежит только хэш.
Куку ставим SameSite=Lax: интерфейс и API живут на одном origin, сторонние
сайты дёргать наш API от имени пользователя не должны.

Флаг Secure включается переменной COOKIE_SECURE — по умолчанию выключен,
потому что сервер обычно стоит в локальной сети без https, а с Secure на http
браузер куку просто не сохранит.
"""

import functools
import os
import threading
import time

from flask import Blueprint, current_app, g, jsonify, request

from app_db import AuthError

COOKIE = 'webuillm_session'


def _flag(name, default):
    """Флаг из окружения. Читается на каждый вызов, а не при импорте: .env
    подхватывается в server.py уже после того, как этот модуль загружен."""
    return os.environ.get(name, default) not in ('0', '', 'false', 'False', 'no')


def cookie_secure():
    return _flag('COOKIE_SECURE', '0')


def allow_registration():
    return _flag('ALLOW_REGISTRATION', '1')

# Простая защита от перебора: после стольких неудач подряд имя закрывается
# на LOCK_SECONDS. Счётчик в памяти — перезапуск сервера его сбрасывает, для
# внутреннего инструмента этого достаточно.
MAX_FAILURES = 7
LOCK_SECONDS = 300

bp = Blueprint('auth', __name__, url_prefix='/api/auth')

_failures = {}
_failures_lock = threading.Lock()


def _db():
    return current_app.config['APP_DB']


def _fail_key(username):
    return ((username or '').strip().lower(), request.remote_addr or '-')


def _locked_for(username):
    """Сколько секунд осталось ждать, 0 — можно пробовать."""
    with _failures_lock:
        rec = _failures.get(_fail_key(username))
        if not rec or rec['count'] < MAX_FAILURES:
            return 0
        left = int(rec['until'] - time.time())
        if left <= 0:
            _failures.pop(_fail_key(username), None)
            return 0
        return left


def _note_failure(username):
    with _failures_lock:
        rec = _failures.setdefault(_fail_key(username), {'count': 0, 'until': 0})
        rec['count'] += 1
        if rec['count'] >= MAX_FAILURES:
            rec['until'] = time.time() + LOCK_SECONDS


def _clear_failures(username):
    with _failures_lock:
        _failures.pop(_fail_key(username), None)


def _issue(user):
    token = _db().create_session(user['id'])
    resp = jsonify({'user': user})
    resp.set_cookie(COOKIE, token, httponly=True, samesite='Lax',
                    secure=cookie_secure(), max_age=30 * 24 * 3600, path='/')
    return resp


def current_user():
    """Пользователь текущего запроса или None. Результат кэшируется на запрос."""
    if 'user' not in g:
        g.user = _db().user_by_session(request.cookies.get(COOKIE))
    return g.user


def login_required(fn):
    """Без действительной сессии — 401 и никакого доступа к бэкенду модели."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return jsonify({'error': 'Требуется вход'}), 401
        return fn(*args, **kwargs)
    return wrapper


# ── маршруты ────────────────────────────────────────────────────────────────
@bp.get('/me')
def me():
    user = current_user()
    if user is None:
        return jsonify({'user': None, 'allow_registration': allow_registration()}), 401
    return jsonify({'user': user, 'allow_registration': allow_registration()})


@bp.post('/register')
def register():
    if not allow_registration():
        return jsonify({'error': 'Регистрация закрыта администратором'}), 403
    data = request.get_json(silent=True) or {}
    try:
        user = _db().create_user(data.get('username'), data.get('password'))
    except AuthError as e:
        return jsonify({'error': str(e)}), 400
    return _issue(user)


@bp.post('/login')
def login():
    data = request.get_json(silent=True) or {}
    username = data.get('username')

    left = _locked_for(username)
    if left:
        return jsonify({'error': f'Слишком много попыток. Подождите {left} с'}), 429

    user = _db().verify_user(username, data.get('password'))
    if user is None:
        _note_failure(username)
        # Не уточняем, что именно не сошлось — иначе форма превращается
        # в проверку существования имён.
        return jsonify({'error': 'Неверное имя или пароль'}), 401

    _clear_failures(username)
    return _issue(user)


@bp.post('/logout')
def logout():
    _db().delete_session(request.cookies.get(COOKIE))
    resp = jsonify({'ok': True})
    resp.delete_cookie(COOKIE, path='/')
    return resp
