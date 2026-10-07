"""
llm_info.py — сколько контекста даёт бэкенд и сколько из него занято.

Мы ничего не ограничиваем — только показываем, чтобы было видно, что диалог
упирается в лимит сессии, до того как модель начнёт терять начало переписки
или бэкенд вернёт ошибку «exceeds the available context size».

Серверов может быть несколько (см. backends.py) — оба запроса уходят на тот,
где живёт выбранная модель: у каждой свой контекст и свой токенайзер.

GET  /api/llm/limits  размер контекста на сессию (слот) и загрузка слотов,
                      а в поле info — паспорт модели: параметры, квантизация,
                      размер файла (для плашки модели в шапке чата).
POST /api/llm/count   сколько токенов займёт переписка, если отправить её
                      модели сейчас. Нужен, когда usage из ответа нет: после
                      «Стоп», при открытии сохранённого чата, после смены
                      системного промпта.

Точные цифры умеет llama.cpp (/slots, /props, /apply-template, /tokenize).
Для прочих бэкендов лимит ищется в /v1/models (max_model_len у vLLM,
context_length у части прокси), а подсчёт отвечает tokens=null — фронт тогда
показывает оценку.
"""

import re

import requests as req
from flask import Blueprint, current_app, jsonify, request

from auth import login_required

bp = Blueprint('llm_info', __name__, url_prefix='/api/llm')

TIMEOUT = 5


def _backends():
    return current_app.config['BACKENDS']


def _get(base, path):
    r = req.get(base + path, headers=_backends().headers(), timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _post(base, path, body, timeout=TIMEOUT):
    r = req.post(base + path, json=body, headers=_backends().headers(), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _int(v):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


# Квант по имени файла/модели: «GLM-5.3-Flash-UD-Q5_K_XL-00001-of-00006.gguf» →
# UD-Q5_K_XL (у llama.cpp в meta только общий тип «Q5_K - Medium», а
# unsloth-овский UD-вариант виден лишь в имени), «071-gptq-g32» → GPTQ.
_QUANT_RE = re.compile(
    r'(?<![A-Za-z0-9])((?:UD-)?(?:IQ\d_[A-Z0-9]+|Q\d_K(?:_[A-Z]{1,2})?|Q\d_\d|TQ\d_\d|MXFP4|BF16|F16|F32)'
    r'|gptq|awq|nf4|fp8|int[48]|w\d+a\d+)(?![A-Za-z0-9])',
    re.IGNORECASE)
# Параметры по имени: «gemma-4-26B-A4B» → 26e9, активных 4e9 (MoE).
_PARAMS_RE = re.compile(r'(?<![\d.])(\d+(?:\.\d+)?)B(?:-A(\d+(?:\.\d+)?)B)?(?![A-Za-z])', re.IGNORECASE)


def _quant_from(*names):
    for name in names:
        m = _QUANT_RE.search(name or '')
        if m:
            q = m.group(1)
            return q.upper() if not q.upper().startswith('UD-') else 'UD-' + q[3:].upper()
    return None


def _params_from(*names):
    for name in names:
        m = _PARAMS_RE.search(name or '')
        if m:
            total = float(m.group(1)) * 1e9
            active = float(m.group(2)) * 1e9 if m.group(2) else None
            return int(total), (int(active) if active else None)
    return None, None


def _model_info(entry, props):
    """Паспорт модели из /v1/models (+ /props у llama.cpp). Чего бэкенд не
    сообщил — пытаемся прочитать из имени файла или модели, остальное None."""
    meta = (entry or {}).get('meta') or {}
    path = (props or {}).get('model_path') or (entry or {}).get('root') or ''
    file = path.replace('\\', '/').rsplit('/', 1)[-1] or None
    model_id = (entry or {}).get('id') or ''

    n_params = _int(meta.get('n_params'))
    name_total, name_active = _params_from(file, model_id, path)
    return {
        'n_params': n_params or name_total,
        'n_params_active': name_active,            # только из имени (…-A4B)
        'params_from_name': n_params is None and name_total is not None,
        'quant': _quant_from(file, model_id, path),
        'ftype': meta.get('ftype') or (props or {}).get('model_ftype'),
        'size': _int(meta.get('size')),
        'n_vocab': _int(meta.get('n_vocab')),
        'file': file,
        'runtime': (entry or {}).get('owned_by'),
    }


@bp.get('/limits')
@login_required
def limits():
    base, model = _backends().resolve((request.args.get('model') or '').strip())
    out = {'n_ctx': None, 'slots': None, 'busy': None, 'n_ctx_train': None, 'info': None}
    props = None

    # llama.cpp: у каждого слота свой n_ctx — это и есть потолок одной сессии.
    # /slots бывает выключен (--no-slots), тогда берём то же из /props.
    try:
        slots = _get(base, '/slots')
        if isinstance(slots, list) and slots:
            sizes = [_int(s.get('n_ctx')) for s in slots if isinstance(s, dict)]
            sizes = [n for n in sizes if n]
            if sizes:
                out['n_ctx'] = min(sizes)
            out['slots'] = len(slots)
            out['busy'] = sum(1 for s in slots if isinstance(s, dict) and s.get('is_processing'))
    except Exception:
        pass

    # /props нужен и для паспорта модели (путь к файлу → квант), поэтому
    # спрашиваем всегда; контекст из него берём, только если /slots молчал.
    try:
        props = _get(base, '/props')
        if out['n_ctx'] is None:
            gen = props.get('default_generation_settings') or {}
            out['n_ctx'] = _int(gen.get('n_ctx')) or _int(props.get('n_ctx'))
            out['slots'] = out['slots'] or _int(props.get('total_slots'))
    except Exception:
        props = None

    # OpenAI-совместимый список моделей: у llama.cpp в meta, у vLLM —
    # max_model_len, у части прокси — context_length.
    try:
        data = _get(base, '/v1/models').get('data') or []
        entry = next((m for m in data if m.get('id') == model), data[0] if data else None)
        if entry:
            meta = entry.get('meta') or {}
            out['n_ctx_train'] = _int(meta.get('n_ctx_train'))
            if out['n_ctx'] is None:
                out['n_ctx'] = (_int(meta.get('n_ctx')) or _int(entry.get('max_model_len'))
                                or _int(entry.get('context_length')))
            out['info'] = _model_info(entry, props)
    except Exception:
        pass

    return jsonify(out)


@bp.post('/count')
@login_required
def count():
    data = request.get_json(silent=True) or {}
    messages = data.get('messages')
    if not isinstance(messages, list):
        return jsonify({'error': 'нужен список messages'}), 400
    if not messages:
        return jsonify({'tokens': 0})

    model = data.get('model') if isinstance(data.get('model'), str) else ''
    base = _backends().url_for(model.strip())
    body = {'messages': messages}
    if isinstance(data.get('chat_template_kwargs'), dict):
        body['chat_template_kwargs'] = data['chat_template_kwargs']
    # Шаблон чата самой модели + её токенайзер — ровно то, что бэкенд положит
    # в контекст. Любой сбой (не llama.cpp, старая сборка) — просто «не знаем».
    try:
        prompt = _post(base, '/apply-template', body, timeout=15).get('prompt')
        if not isinstance(prompt, str):
            raise ValueError('нет prompt')
        tokens = _post(base, '/tokenize', {'content': prompt, 'add_special': True}, timeout=15).get('tokens')
        if not isinstance(tokens, list):
            raise ValueError('нет tokens')
    except Exception:
        return jsonify({'tokens': None})
    return jsonify({'tokens': len(tokens)})
