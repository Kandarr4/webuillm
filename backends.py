"""
backends.py — несколько серверов моделей за одним прокси.

Откуда берётся список серверов:

  LM_REGISTRY — адрес реестра моделей (GET / отдаёт поле servers: адрес,
      признак связи, тип модели). Серверы появляются и пропадают сами, порты
      в настройке не нужны:
          LM_REGISTRY=http://your-server:7000
  LM_BACKEND — статический список через запятую. Без реестра — основной
      источник, с реестром — запасной: если реестр не ответил и прежнего
      его списка ещё нет.
          LM_BACKEND=http://your-server:8080,http://your-server:8081

Реестр опрашивает /v1/models у каждого сервера. Браузер видит один общий
список (с портом у каждой модели, но без адресов) и сам сервер не выбирает:
запрос с полем "model" прокси отправляет на нужный.

У каждой записи списка есть поле server — метка сервера для интерфейса
(«:8081», или «хост:порт», если серверы на разных хостах), а в ответе
/v1/models — перечень серверов с признаком связи: упавший сервер виден в
интерфейсе, а не просто молча пропадает из списка.

И поля kind/input: kind "asr" — речевая модель (аудио → расшифровка, свой
формат потока), "llm" — обычный чат; input — что модель принимает ("audio",
"text"). По ним интерфейс решает, давать ли приложить запись и как читать
ответ. Реестр сообщает их сам; для серверов из LM_BACKEND тип узнаётся по
/health: ASR-сервер отвечает там с полем window_sec.

Каждая модель на каждом сервере — отдельный экземпляр: одна и та же модель,
поднятая на двух портах, — это две независимые очереди и два независимых
контекста, а не одна «общая» модель. Если имя встречается на нескольких
серверах, в списке к нему добавляется номер сервера: «qwen #1», «qwen #2».
Номер — место сервера в списке всех серверов, какие были видны с запуска
(сначала LM_BACKEND, потом новые из реестра), а не среди живых сейчас, —
выбранный экземпляр не подменяется другим, если соседний сервер упал. Перед
отправкой на бэкенд имя возвращается настоящее.

Список кэшируется на TTL секунд; устаревший отдаётся сразу, а свежий
дочитывается в фоне — запрос в чат не ждёт опроса серверов. Это важно для
упавшего сервера: на Windows попытка подключиться к закрытому порту висит,
пока ОС повторяет SYN, поэтому и таймаут на подключение короткий. Если
модели нет в кэше (сервер только что поднялся, модель перезагрузили), список
перечитывается сразу, не дожидаясь истечения TTL. Упавший сервер не мешает
остальным — его модели пропадают из списка до следующего опроса, а сам он
помечается «нет связи».
"""

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

import requests as req

log = logging.getLogger("webuillm")

TTL = 15
TIMEOUT = 5
CONNECT_TIMEOUT = 1.5   # до лежащего сервера — не дольше этого
MIN_FORCED = 3      # внеочередное перечитывание — не чаще, чем раз в столько секунд

_NUMBERED = re.compile(r'^(.+) #(\d+)$')

LLM = {'kind': 'llm', 'input': ['text']}
ASR = {'kind': 'asr', 'input': ['audio', 'text']}


def parse_backends(value):
    """'a, b,,c/' → ['a', 'b', 'c'] — без пустых, без хвостовых слэшей, без повторов."""
    out = []
    for part in (value or '').split(','):
        url = part.strip().rstrip('/')
        if url and url not in out:
            out.append(url)
    return out


class BackendRegistry:
    def __init__(self, urls, token='', registry=''):
        self.registry = (registry or '').strip().rstrip('/')
        if not urls and not self.registry:
            raise ValueError('не задан ни один бэкенд (LM_BACKEND или LM_REGISTRY)')
        self.fallback = list(urls)
        self.token = token
        self._lock = threading.Lock()
        self.urls = list(urls)      # все серверы, какие были видны: номер «#N» — место здесь
        self._current = list(urls)  # серверы последнего опроса, по порядку
        self._entries = []          # записи /v1/models с публичным id
        self._where = {}            # публичный id → (url, настоящий id)
        self._at = 0.0
        self._alive = {}            # url → ответил ли на последний опрос
        self._types = {}            # url → {'kind', 'input'}
        self._from_registry = None  # последний ответ реестра: [(url, ok)]
        self._registry_ok = None
        self._refreshing = False
        self.labels = _server_labels(self.urls)

    @property
    def default(self):
        """Сервер для запросов без модели: первый живой чат, иначе первый известный."""
        with self._lock:
            live = [u for u in self._current if self._alive.get(u)] or self._current or self.urls
            chat = [u for u in live if self._types.get(u, LLM)['kind'] != 'asr']
            return (chat or live or [None])[0]

    def headers(self):
        return {'Authorization': 'Bearer ' + self.token} if self.token else {}

    # ── опрос ────────────────────────────────────────────────────────────────
    def _get(self, url):
        r = req.get(url, headers=self.headers(), timeout=(CONNECT_TIMEOUT, TIMEOUT))
        r.raise_for_status()
        return r.json()

    def _discover(self):
        """Какие серверы опрашивать: [(url, ok по мнению реестра)].

        Реестр не ответил — его прежний список (серверы, скорее всего, на
        месте), а если реестр не отвечал ни разу — LM_BACKEND.
        """
        if not self.registry:
            return [(u, True) for u in self.fallback]
        try:
            servers = self._get(self.registry + '/').get('servers') or []
            found = []
            for s in servers:
                url = str(s.get('url') or '').strip().rstrip('/')
                if not url or any(u == url for u, _ in found):
                    continue
                if s.get('kind'):
                    kind = 'asr' if s['kind'] == 'asr' else 'llm'
                    inp = [str(x) for x in (s.get('input') or [])] or list((ASR if kind == 'asr' else LLM)['input'])
                    with self._lock:
                        self._types[url] = {'kind': kind, 'input': inp}
                found.append((url, s.get('ok') is not False))
            if self._registry_ok is False:
                log.info("реестр %s снова отвечает", self.registry)
            self._registry_ok = True
            self._from_registry = found
            return found
        except Exception as e:
            if self._registry_ok is not False:
                log.warning("реестр %s недоступен: %s", self.registry, e)
            self._registry_ok = False
            if self._from_registry is not None:
                return self._from_registry
            return [(u, True) for u in self.fallback]

    def _type_of(self, url):
        """Тип сервера. Реестр сообщает его сам; иначе — по /health: ASR-сервер
        отдаёт там window_sec. Узнанное запоминается, пока сервер жив."""
        with self._lock:
            known = self._types.get(url)
        if known:
            return known
        try:
            health = self._get(url + '/health')
            found = ASR if isinstance(health, dict) and 'window_sec' in health else LLM
        except Exception:
            found = LLM   # llama.cpp без /health, vLLM отвечает пустым телом
        with self._lock:
            self._types[url] = found
        return found

    def _fetch(self, target):
        url, ok = target
        if not ok:              # реестр уже знает, что сервер лежит, — не ждём таймаута
            return url, None
        try:
            models = [m for m in (self._get(url + '/v1/models').get('data') or []) if m.get('id')]
        except Exception as e:
            log.warning("бэкенд %s: список моделей недоступен: %s", url, e)
            if not self.registry:
                with self._lock:
                    self._types.pop(url, None)   # вернётся — узнаем тип заново
            return url, None
        self._type_of(url)
        return url, models

    def refresh(self):
        targets = self._discover()
        with self._lock:
            grew = [u for u, _ in targets if u not in self.urls]
            if grew:
                self.urls.extend(grew)
                self.labels = _server_labels(self.urls)
        results = []
        if targets:
            with ThreadPoolExecutor(max_workers=len(targets)) as ex:
                results = list(ex.map(self._fetch, targets))
        alive = {url: models is not None for url, models in results}
        results = [(url, models or []) for url, models in results]
        hosts = {}
        for url, models in results:
            for m in models:
                hosts.setdefault(m['id'], set()).add(url)

        with self._lock:
            labels, types = dict(self.labels), dict(self._types)
        entries, where = [], {}
        for url, models in results:          # порядок — как в источнике списка
            n = self.urls.index(url) + 1
            for m in models:
                real = m['id']
                public = f'{real} #{n}' if len(hosts[real]) > 1 else real
                if public in where:           # один сервер отдал имя дважды
                    continue
                where[public] = (url, real)
                entries.append({**m, 'id': public, 'name': real, 'server': labels[url],
                                **types.get(url, LLM)})
        with self._lock:
            self._entries, self._where, self._at = entries, where, time.monotonic()
            self._alive = alive
            self._current = [u for u, _ in targets]
        return entries

    def _fresh(self):
        """Список из кэша. Устарел — отдаём его же и дочитываем в фоне; ждём
        опроса только когда кэша ещё нет совсем."""
        with self._lock:
            if self._at and time.monotonic() - self._at < TTL:
                return self._entries
            if self._at:
                if not self._refreshing:
                    self._refreshing = True
                    threading.Thread(target=self._background_refresh, daemon=True).start()
                return self._entries
        return self.refresh()

    def _background_refresh(self):
        try:
            self.refresh()
        finally:
            with self._lock:
                self._refreshing = False

    def models(self, force=False):
        """Экземпляры моделей всех серверов в формате OpenAI /v1/models.
        force — опросить серверы сейчас (кнопка «проверить связь»)."""
        return self.refresh() if force else self._fresh()

    def servers(self):
        """Серверы последнего опроса по порядку: метка, есть ли связь, тип.
        Молчащий реестр — тоже строкой: без него список может устареть."""
        with self._lock:
            out = [{'server': self.labels[u], 'ok': bool(self._alive.get(u)),
                    'kind': self._types.get(u, LLM)['kind']} for u in self._current]
            if self._registry_ok is False:
                out.insert(0, {'server': 'реестр ' + _host_port(self.registry), 'ok': False,
                               'kind': 'registry'})
            return out

    def resolve(self, model):
        """Публичное имя → (адрес сервера, настоящее имя модели).

        «имя #N» — всегда N-й сервер из списка всех виденных, даже если сейчас
        имя не дублируется (второй экземпляр упал): выбор пользователя не
        должен молча переехать на другой сервер. Просто «имя» — первый сервер,
        где модель есть. Незнакомая или пустая модель — сервер по умолчанию
        (None, если серверов не видно ни одного).
        """
        if not model:
            return self.default, model
        m = _NUMBERED.match(model)
        if m and 1 <= int(m.group(2)) <= len(self.urls):
            return self.urls[int(m.group(2)) - 1], m.group(1)

        self._fresh()
        with self._lock:
            hit = self._where.get(model) or self._first_host(model)
            stale = time.monotonic() - self._at > MIN_FORCED
        if hit is None and stale:
            self.refresh()
            with self._lock:
                hit = self._where.get(model) or self._first_host(model)
        return hit or (self.default, model)

    def _first_host(self, real):
        """Сервер с моделью по её настоящему имени (у дублей в списке — «#N»)."""
        for url, name in self._where.values():
            if name == real:
                return url, name
        return None

    def url_for(self, model):
        return self.resolve(model)[0]


def _host_port(url):
    sp = urlsplit(url)
    return f'{sp.hostname or url}:{sp.port or (443 if sp.scheme == "https" else 80)}'


def _server_labels(urls):
    """Короткие метки серверов: «:8080», а при разных хостах — «хост:8080»."""
    parts = []
    for u in urls:
        sp = urlsplit(u)
        port = sp.port or (443 if sp.scheme == 'https' else 80)
        parts.append((sp.hostname or u, port, sp.path.rstrip('/')))
    one_host = len({h for h, _, _ in parts}) == 1
    labels = {}
    for u, (host, port, path) in zip(urls, parts):
        label = (f':{port}' if one_host else f'{host}:{port}') + path
        labels[u] = label if label not in labels.values() else u
    return labels
