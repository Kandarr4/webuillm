"""
chats_api.py — чаты пользователя: список, чтение, переименование, удаление,
дописывание, правка реплик и обрезка переписки (для перегенерации ответа).

Все запросы проходят через login_required, а внутри — через проверку
владельца: чужой чат по прямому id не открыть и не удалить.
"""

from flask import Blueprint, current_app, jsonify, request

from app_db import AuthError
from auth import current_user, login_required

bp = Blueprint('chats', __name__, url_prefix='/api/chats')

MAX_CONTENT = 200_000     # потолок на реплику, чтобы база не росла бесконтрольно


def _db():
    return current_app.config['APP_DB']


@bp.get('')
@login_required
def list_chats():
    return jsonify({'chats': _db().list_chats(current_user()['id'])})


@bp.post('')
@login_required
def create_chat():
    data = request.get_json(silent=True) or {}
    return jsonify({'chat': _db().create_chat(current_user()['id'], data.get('title'))}), 201


@bp.get('/<int:chat_id>')
@login_required
def get_chat(chat_id):
    chat = _db().get_chat(current_user()['id'], chat_id)
    if chat is None:
        return jsonify({'error': 'Чат не найден'}), 404
    return jsonify({'chat': chat})


@bp.patch('/<int:chat_id>')
@login_required
def rename_chat(chat_id):
    data = request.get_json(silent=True) or {}
    try:
        chat = _db().rename_chat(current_user()['id'], chat_id, data.get('title'))
    except AuthError as e:
        return jsonify({'error': str(e)}), 400
    if chat is None:
        return jsonify({'error': 'Чат не найден'}), 404
    return jsonify({'chat': chat})


@bp.delete('/<int:chat_id>')
@login_required
def delete_chat(chat_id):
    if not _db().delete_chat(current_user()['id'], chat_id):
        return jsonify({'error': 'Чат не найден'}), 404
    return jsonify({'ok': True})


@bp.post('/<int:chat_id>/messages')
@login_required
def add_message(chat_id):
    data = request.get_json(silent=True) or {}
    content = data.get('content') or ''
    if len(content) > MAX_CONTENT:
        return jsonify({'error': 'Слишком длинная реплика'}), 413
    try:
        msg = _db().add_message(current_user()['id'], chat_id, data.get('role'), content,
                                data.get('stats'))
    except AuthError as e:
        return jsonify({'error': str(e)}), 400
    if msg is None:
        return jsonify({'error': 'Чат не найден'}), 404
    return jsonify({'message': msg}), 201


@bp.patch('/<int:chat_id>/messages/<int:msg_id>')
@login_required
def edit_message(chat_id, msg_id):
    data = request.get_json(silent=True) or {}
    content = data.get('content')
    if not isinstance(content, str):
        return jsonify({'error': 'нужен content'}), 400
    if len(content) > MAX_CONTENT:
        return jsonify({'error': 'Слишком длинная реплика'}), 413
    msg = _db().update_message(current_user()['id'], chat_id, msg_id, content)
    if msg is None:
        return jsonify({'error': 'Реплика не найдена'}), 404
    return jsonify({'message': msg})


# Удалить реплику и всё после неё: перегенерация ответа и переотправка
# правленого вопроса начинают переписку с этого места заново.
@bp.delete('/<int:chat_id>/messages/<int:msg_id>/and-after')
@login_required
def truncate_messages(chat_id, msg_id):
    n = _db().truncate_messages(current_user()['id'], chat_id, msg_id)
    if n is None:
        return jsonify({'error': 'Чат не найден'}), 404
    return jsonify({'deleted': n})
