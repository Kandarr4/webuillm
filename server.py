"""
server.py — сервер WebUiLlm.

Отдаёт собранный React-фронт из static/dist и проксирует /v1/* и /api/* на
OpenAI-совместимые бэкенды (их может быть несколько — запрос уходит на тот,
где живёт запрошенная модель). Браузер общается только с этим сервером —
адреса бэкендов и CORS скрыты за прокси.

Запуск:
    pip install -r requirements.txt
    cd web && npm ci && npm run build      # один раз после клонирования
    python server.py

Откроется на http://localhost:5900

Настройки — из файла .env рядом с server.py либо из переменных окружения
(образец — .env.example). Переменная, заданная снаружи, важнее .env:
    LM_REGISTRY  адрес реестра моделей — список серверов берётся из него
                 (например http://your-server:7000)
    LM_BACKEND   адрес бэкенда или несколько через запятую; при LM_REGISTRY —
                 запасной список (без реестра по умолчанию
                 http://127.0.0.1:8080)
    HOST / PORT  что слушать            (0.0.0.0:5900)

Страница /local — очередь пакетной обработки файлов из
static/audio_package/<пакет> (проверка на тишину через ffmpeg, .spx→wav,
транскрипция, <F_ID>.txt рядом с аудио и <пакет>.xlsx с джойном
metadata.json). См. local_processing.py.
"""

import os
import base64
import json
import logging
from datetime import datetime

import requests as req
from flask import Flask, send_from_directory, request, Response, stream_with_context, jsonify

from backends import BackendRegistry, parse_backends
from local_processing import LocalProcessor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(BASE_DIR, "static", "dist")   # сборка фронта (vite)


def load_dotenv(path):
    """Перенести пары KEY=VALUE из .env в окружение процесса.

    Переменные, заданные снаружи, важнее файла и не перезаписываются — так же
    ведёт себя python-dotenv, и так можно разово поднять сервер на другом порту
    (PORT=5901 python server.py), не трогая .env.

    utf-8-sig, потому что Блокнот и PowerShell охотно пишут BOM, а с ним имя
    первой переменной читалось бы как "\ufeffLM_BACKEND" и молча не срабатывало.
    """
    if not os.path.exists(path):
        return []
    taken = []
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):].lstrip()
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                if not key or key in os.environ:
                    continue
                os.environ[key] = val
                taken.append(key)
    except OSError as e:
        print(f"ВНИМАНИЕ: не удалось прочитать .env: {e}")
    return taken


ENV_FILE = os.path.join(BASE_DIR, ".env")
ENV_TAKEN = load_dotenv(ENV_FILE)

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5900"))

# Реестр моделей: сам знает, какие серверы подняты и на каких портах. С ним
# LM_BACKEND — только запас на случай, если реестр не ответил.
LM_REGISTRY = os.environ.get("LM_REGISTRY", "").strip()

# Адреса OpenAI-совместимых бэкендов через запятую. Запросы без модели и к
# моделям, которых нет ни на одном сервере, идут на первый живой чат-сервер.
LM_BACKENDS = parse_backends(os.environ.get(
    "LM_BACKEND", "" if LM_REGISTRY else "http://127.0.0.1:8080"))
if not LM_BACKENDS and not LM_REGISTRY:
    raise SystemExit("LM_BACKEND пуст — укажите адрес сервера модели или LM_REGISTRY")

# Токен к бэкенду модели теперь серверный: в интерфейсе поля для него больше
# нет, и ключ не должен лежать в браузере у каждого пользователя.
LM_BACKEND_TOKEN = os.environ.get("LM_BACKEND_TOKEN", "").strip()

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("webuillm")

app = Flask(__name__)   # статика — папка static/, там же лежит сборка dist/

# ─── Учётные записи и чаты ────────────────────────────────────────────────────
# Отдельная база от очереди пакетной обработки: здесь учётки и переписка.
from app_db import AppDB          # noqa: E402  (после загрузки .env)
import auth                       # noqa: E402
import chats_api                  # noqa: E402
import llm_info                   # noqa: E402

APP_DB_PATH = os.environ.get("APP_DB_PATH", os.path.join(BASE_DIR, "webuillm.db"))
app.config["APP_DB"] = AppDB(APP_DB_PATH, log)
BACKENDS = BackendRegistry(LM_BACKENDS, LM_BACKEND_TOKEN, LM_REGISTRY)
app.config["BACKENDS"] = BACKENDS
app.register_blueprint(auth.bp)
app.register_blueprint(chats_api.bp)
app.register_blueprint(llm_info.bp)
app.config["APP_DB"].purge_expired_sessions()

# ─── Локальная обработка ──────────────────────────────────────────────────────
local_processor = LocalProcessor(base_dir=BASE_DIR, logger=log,
                                 resolve_backend=BACKENDS.resolve, list_models=BACKENDS.models)


# ─── Конвертация аудио для чата ───────────────────────────────────────────────
# ASR-бэкенд (asr_server.py) намеренно без ffmpeg и ждёт УЖЕ готовый 16к-моно PCM
# WAV. Локальная обработка конвертирует файлы сама; чат-путь раньше слал сырые
# байты (mp3/стерео/не-16к) → бэкенд не декодировал. Здесь, до форварда на
# бэкенд, приводим аудио из тела чата к тому же формату тем же рецептом ffmpeg.
_EXT_BY_MIME = {
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac',
    'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    # .spx (Ogg-Speex) — основной формат загрузки
    'audio/spx': 'spx', 'audio/speex': 'spx', 'audio/x-speex': 'spx',
}


def _convert_data_uri(uri):
    """data:audio/...;base64,... → 16к-моно WAV data-URI. None если не вышло."""
    if not isinstance(uri, str) or not uri.startswith('data:') or ',' not in uri:
        return None
    header, b64 = uri.split(',', 1)
    mime = header[5:].split(';')[0].strip().lower()   # после 'data:'
    src_ext = _EXT_BY_MIME.get(mime, '')
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None
    wav = local_processor.convert_bytes_to_asr_wav(raw, src_ext)
    if wav is None:
        return None
    return 'data:audio/wav;base64,' + base64.b64encode(wav).decode('ascii')


def convert_chat_audio(body):
    """На месте конвертирует все аудио-части тела /v1/chat/completions в 16к-моно
    WAV. Поддерживает Gemma-диалект (audio_url) и OpenAI (input_audio). Возвращает
    число сконвертированных клипов. No-op, если ffmpeg недоступен или аудио нет."""
    if not local_processor.ffmpeg_available():
        return 0
    n = 0
    for msg in body.get('messages', []):
        content = msg.get('content') if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get('type') == 'audio_url':
                au = part.get('audio_url') or {}
                new = _convert_data_uri(au.get('url'))
                if new:
                    au['url'] = new
                    part['audio_url'] = au
                    n += 1
            elif part.get('type') == 'input_audio':
                ia = part.get('input_audio') or {}
                data = ia.get('data')
                if not data:
                    continue
                fmt = (ia.get('format') or 'wav').lower()
                new = _convert_data_uri(f'data:audio/{fmt};base64,{data}')
                if new:
                    ia['data'] = new.split(',', 1)[1]
                    ia['format'] = 'wav'
                    part['input_audio'] = ia
                    n += 1
    return n


# ─── Собранный фронт ──────────────────────────────────────────────────────────
# Весь UI — одно React-приложение (папка web/, сборка в static/dist). Маршруты
# страниц («/», «/local») обслуживает роутер в браузере, поэтому сервер отдаёт
# на них один и тот же index.html.
NO_BUILD_PAGE = """<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>WebUiLlm — фронт не собран</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:0 24px;
line-height:1.6;color:#1a1a26}code{background:#ececf2;padding:2px 6px;border-radius:4px}
pre{background:#ececf2;padding:14px 16px;border-radius:8px}</style>
</head><body>
<h1>Фронтенд не собран</h1>
<p>Нет файла <code>static/dist/index.html</code>. Соберите интерфейс:</p>
<pre><code>cd web
npm ci
npm run build</code></pre>
<p>После сборки обновите страницу. API и локальная обработка уже работают.</p>
</body></html>"""


def spa():
    """Любая страница фронта — один и тот же index.html сборки."""
    if not os.path.exists(os.path.join(DIST_DIR, "index.html")):
        return Response(NO_BUILD_PAGE, content_type="text/html; charset=utf-8", status=503)
    return send_from_directory(DIST_DIR, "index.html")


@app.route("/")
def index():
    return spa()


@app.route("/local")
def local_page():
    return spa()


# ─── Локальная обработка ──────────────────────────────────────────────────────
# API переехало под /api/local/*: путь /local занят страницей React-роутера.
# Старые адреса оставлены рабочими — на них могли остаться закладки и скрипты.
def _dual(rule, **kw):
    """Регистрирует обработчик и под /api/local/…, и под старым /local/…"""
    def deco(fn):
        guarded = auth.login_required(fn)
        app.add_url_rule("/api/local" + rule, fn.__name__, guarded, **kw)
        app.add_url_rule("/local" + rule, fn.__name__ + "_legacy", guarded, **kw)
        return fn
    return deco


@_dual("/status")
def local_status():
    return jsonify(local_processor.status_summary())


@_dual("/start", methods=["POST"])
def local_start():
    started = local_processor.start()
    return jsonify({"ok": True, "started": started,
                    "status": local_processor.status_summary()})


@_dual("/stop", methods=["POST"])
def local_stop():
    local_processor.stop()
    return jsonify({"ok": True, "status": local_processor.status_summary()})


@_dual("/rescan", methods=["POST"])
def local_rescan():
    added = local_processor.scan()
    return jsonify({"ok": True, "added": added,
                    "status": local_processor.status_summary()})


@_dual("/config", methods=["POST"])
def local_config():
    data = request.get_json(silent=True) or {}
    local_processor.set_config(
        input_dir=data.get("input_dir"),
        model=data.get("model"),
        prompt=data.get("prompt"),
    )
    added = local_processor.scan()
    return jsonify({"ok": True, "added": added,
                    "status": local_processor.status_summary()})


@_dual("/xlsx/<package>")
def local_xlsx(package):
    path = local_processor.xlsx_path(package)
    if not os.path.exists(path):
        return jsonify({"error": "XLSX ещё не сформирован"}), 404
    return send_from_directory(os.path.dirname(path), os.path.basename(path),
                               as_attachment=True, download_name=f"{package}.xlsx")


# ─── Сохранение результатов тестирования ─────────────────────────────────────
# Кнопка «Сохранить тест» в чате шлёт сюда JSON (имя аудио, транскрипт, все
# параметры запроса и метрики). Файл кладём в front/tests с именем от ТЕКУЩЕГО
# ВРЕМЕНИ («ГГ.ММ.ДД чч.мм.сс.json»), а не от имени аудио — один и тот же файл
# может тестироваться многократно, перезаписи быть не должно.
TESTS_DIR = os.path.join(BASE_DIR, "tests")


@app.route("/tests/save", methods=["POST"])
@auth.login_required
def tests_save():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:
        return jsonify({"ok": False, "error": "пустое тело — нечего сохранять"}), 400
    os.makedirs(TESTS_DIR, exist_ok=True)
    now = datetime.now()
    stem = now.strftime("%y.%m.%d %H.%M.%S")
    path = os.path.join(TESTS_DIR, stem + ".json")
    k = 1
    while os.path.exists(path):          # два сохранения в одну секунду
        path = os.path.join(TESTS_DIR, f"{stem} ({k}).json")
        k += 1
    data.setdefault("saved_at", now.isoformat(timespec="seconds"))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    fname = os.path.basename(path)
    log.info("тест сохранён: tests/%s", fname)
    return jsonify({"ok": True, "file": fname})


@app.route("/<path:filename>")
def catch_all(filename):
    """Неизвестный путь — отдаём страницу фронта (маршрутизация в браузере).

    Раньше здесь стоял send_from_directory(BASE_DIR, filename), и по HTTP
    наружу раздавался весь корень проекта: GET /server.py возвращал исходник,
    GET /local_state.json — рантайм-состояние. Файлы сборки отдаёт Flask сам
    по /static/dist/*, остальному в корне делать в ответе нечего.
    """
    if filename.startswith(("v1/", "api/")):
        return {"error": "not found"}, 404
    return spa()


# ─── Прокси → бэкенд ──────────────────────────────────────────────────────────
# Все /v1/* и /api/* Flask прозрачно форвардит на бэкенд, сохраняя потоковый
# (SSE) ответ. Бэкенд выбирается по полю "model" тела запроса; список моделей
# (/v1/models) собирается со всех серверов сразу.
@app.route("/v1/<path:path>", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/<path:path>", methods=["GET", "POST", "OPTIONS"])
def api_proxy(path):
    if request.method == "OPTIONS":
        return app.make_default_options_response()

    # Без входа бэкенд модели наружу не отдаём: прокси — это доступ к железу.
    if auth.current_user() is None:
        return {"error": "Требуется вход"}, 401

    if path == "models" and request.path.startswith("/v1/") and request.method == "GET":
        models = BACKENDS.models(force=request.args.get("refresh") == "1")
        return jsonify({"object": "list", "data": models, "servers": BACKENDS.servers()})

    body = request.get_json(silent=True)
    model = body.get("model") if isinstance(body, dict) else None
    backend, real_model = BACKENDS.resolve(model if isinstance(model, str) else None)
    if backend is None:
        return {"error": "Нет ни одного доступного сервера моделей"}, 502
    # «qwen #2» — имя экземпляра в нашем списке; бэкенд знает модель как «qwen».
    if real_model and real_model != model:
        body["model"] = real_model
    target_url = f"{backend}{request.full_path.rstrip('?')}"
    # Раньше на бэкенд уходили ВСЕ заголовки браузера (Cookie, Origin,
    # Content-Length от уже распарсенного тела, hop-by-hop). Пропускаем только
    # нужное, а авторизацию к модели подставляем свою — браузер её не знает.
    headers = {k: v for k, v in request.headers
               if k.lower() in ("accept", "content-type")}
    if LM_BACKEND_TOKEN:
        headers["Authorization"] = "Bearer " + LM_BACKEND_TOKEN

    try:
        stream = bool(isinstance(body, dict) and body.get("stream"))

        # Аудио из чата приходит сырым (mp3/стерео/не-16к); бэкенду без ffmpeg
        # нужен 16к-моно WAV. Конвертируем тем же рецептом, что локальная обработка.
        if body and path == "chat/completions" and isinstance(body.get("messages"), list):
            try:
                converted = convert_chat_audio(body)
                if converted:
                    log.info("chat: сконвертировано аудио-клипов → 16к моно wav: %d", converted)
            except Exception as e:
                log.warning("chat: конвертация аудио не удалась: %s", e)

        r = req.request(
            method=request.method,
            url=target_url,
            json=body if body else None,
            headers=headers,
            stream=stream,
            # Поток шлёт кадры всё время, и 300 с — это пауза между ними. Без
            # потока ответ приходит целиком в конце: распознавание длинной
            # записи идёт десятки минут (час аудио — до ~35 мин).
            timeout=(10, 300 if stream or path != "chat/completions" else 3600),
        )

        if stream:
            return Response(
                stream_with_context(r.iter_content(chunk_size=None)),
                content_type=r.headers.get("Content-Type", "text/event-stream"),
                status=r.status_code,
            )
        return Response(
            r.content,
            content_type=r.headers.get("Content-Type", "application/json"),
            status=r.status_code,
        )
    except Exception as e:
        return {"error": str(e)}, 502


if __name__ == "__main__":
    print("WebUiLlm")
    print(f"http://localhost:{PORT}")
    # Заодно прогреваем список моделей — первая страница не ждёт опроса.
    found = BACKENDS.refresh()
    if LM_REGISTRY:
        print(f"Реестр: {LM_REGISTRY}")
    for s in BACKENDS.servers():
        ids = [m["id"] + (" (ASR)" if m["kind"] == "asr" else "")
               for m in found if m["server"] == s["server"]]
        url = next((u for u, lb in BACKENDS.labels.items() if lb == s["server"]), s["server"])
        print(f"Backend: {url}  →  {', '.join(ids) if s['ok'] else 'нет связи'}")
    users = app.config["APP_DB"].user_count()
    print(f"Пользователей: {users}" + (" — первым делом зарегистрируйтесь" if not users else ""))
    if ENV_TAKEN:
        print(f"Из .env: {', '.join(ENV_TAKEN)}")
    elif os.path.exists(ENV_FILE):
        print("В .env нет новых переменных (значения уже заданы в окружении)")
    if not os.path.exists(os.path.join(DIST_DIR, "index.html")):
        print("ВНИМАНИЕ: фронт не собран — выполните: cd web && npm ci && npm run build")
    app.run(host=HOST, port=PORT, debug=False)
