// Сквозная проверка: собранный интерфейс в jsdom → настоящий Flask → настоящая
// SQLite → поддельный бэкенд модели. Ничего не подменяется, кроме самой модели.
//
//   npm run build && npm run smoke
//
// Поднимается всё на временной базе и своих портах, после прогона убирается.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(HERE, '..');
const DIST = path.join(PROJ, 'static', 'dist');

const FLASK_PORT = 5912;
const LLM_PORT = 5913;
const LLM2_PORT = 5914;
const DEAD_PORT = 5915;
const ASR_PORT = 5916;
const BASE = `http://127.0.0.1:${FLASK_PORT}`;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('НЕТ СБОРКИ: сначала npm run build');
  process.exit(1);
}

const fails = [];
const check = (name, cond, extra = '') => {
  console.log((cond ? 'ПРОШЛО ' : 'УПАЛО  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Поддельный бэкенд модели ────────────────────────────────────────────────
// Отвечает по-настоящему потоком и докладывает, сколько реплик ему прислали, —
// так проверяется, что история диалога доходит до модели. Ответ — в Markdown,
// с usage в последнем кадре. Изображает и llama.cpp-эндпоинты контекста:
// слоты по 4096 токенов, «токен» = слово.
let lastLlmBody = null;
const llm = http.createServer((req, res) => {
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/v1/models')) return json({ data: [{ id: 'test-model' }] });
  if (req.url === '/slots') {
    return json([{ id: 0, n_ctx: 4096, is_processing: false }, { id: 1, n_ctx: 4096, is_processing: false }]);
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url === '/apply-template') {
      return json({ prompt: (body.messages || []).map((m) => m.content).join('\n') });
    }
    if (req.url === '/tokenize') {
      return json({ tokens: String(body.content || '').split(/\s+/).filter(Boolean).map((_, i) => i) });
    }
    lastLlmBody = body;
    const n = (lastLlmBody.messages || []).length;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const code = '\n\n```python\n' + Array.from({ length: 20 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n```';
    for (const piece of ['**Ответ**', ' на ', String(n), ' реплик', code]) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    }
    if (lastLlmBody.stream_options?.include_usage) {
      res.write('data: ' + JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
        timings: { prompt_n: 100, cache_n: 0, prompt_per_second: 900, predicted_n: 5, predicted_per_second: 42.5 },
      }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

// Второй сервер со своей моделью и другим контекстом — прокси должен сам
// отправлять на него запросы к second-model. test-model поднята и тут —
// это второй, независимый экземпляр.
let lastLlm2Body = null;
const llm2 = http.createServer((req, res) => {
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/v1/models')) return json({ data: [{ id: 'second-model' }, { id: 'test-model' }] });
  if (req.url === '/slots') return json([{ id: 0, n_ctx: 8192, is_processing: false }]);
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url === '/apply-template') return json({ prompt: 'x' });
    if (req.url === '/tokenize') return json({ tokens: [1, 2, 3] });
    lastLlm2Body = body;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Вторая модель ответила' } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => llm2.listen(LLM2_PORT, '127.0.0.1', r));

// Речевая модель: узнаётся по /health (window_sec), отвечает своим потоком
// событий — два окна по 90 с (таймкоды второго — от начала окна), петля,
// которую сторож откатывает событием discard.
let lastAsrBody = null;
let lastAsrWav = null;
const ASR_EVENTS = [
  { type: 'stage', stage: 'prepare', text: 'Готовлю аудио…' },
  { type: 'info', windows: 2, audio_sec: 95, segments: [] },
  { type: 'window', index: 1, total: 2, window_sec: 90, start_sec: 0 },
  { type: 'delta', text: '[00:01.0 - 00:02.0] [Speaker 1, neutral]: Привет' },
  { type: 'delta', text: ' мир мир мир' },
  { type: 'stage', stage: 'loop', text: 'Сработал сторож петель' },
  { type: 'discard', chars: ' мир мир мир'.length },
  { type: 'delta', text: '\n' },
  { type: 'metrics', elapsed: 1, tok_per_sec: 35.2, tokens: 20, rtf_live: 0.1 },
  { type: 'window', index: 2, total: 2, window_sec: 5, start_sec: 90 },
  { type: 'delta', text: '[00:03.5 - 00:05.0] [Speaker 1, neutral]: Второе окно\n[note]:\nSpeaker 1, male' },
  { type: 'done', audio_sec: 95, inference_sec: 47.5, rtf: 0.5, windows: 2, loops_truncated: 1, prompt_tokens: 5000, completion_tokens: 40 },
];
const asr = http.createServer((req, res) => {
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/health') return json({ ok: true, model_id: 'asr-model', window_sec: 90 });
  if (req.url.startsWith('/v1/models')) return json({ data: [{ id: 'asr-model' }] });
  // llama.cpp-эндпоинтов контекста (/apply-template, /slots) у vLLM нет
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    lastAsrBody = JSON.parse(raw || '{}');
    const url = lastAsrBody.messages?.[0]?.content?.[0]?.audio_url?.url || '';
    const wav = Buffer.from(url.split(',')[1] || '', 'base64');
    lastAsrWav = wav.length >= 28
      ? { mime: url.slice(5, url.indexOf(';')), channels: wav.readUInt16LE(22), rate: wav.readUInt32LE(24) }
      : null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const ev of ASR_EVENTS) res.write('data: ' + JSON.stringify(ev) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => asr.listen(ASR_PORT, '127.0.0.1', r));

// Запись для загрузки: 1 с тона, 8 кГц, стерео — не тот формат, что ждёт
// модель, прокси должен привести его к 16 кГц моно.
function toneWav() {
  const rate = 8000, ch = 2, n = rate;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000);
    for (let c = 0; c < ch; c++) buf.writeInt16LE(v, 44 + (i * ch + c) * 2);
  }
  return buf;
}
const HAS_FFMPEG = fs.existsSync(path.join(PROJ, 'ffmpeg', 'bin', 'ffmpeg.exe'));

// ── Настоящий сервер приложения ─────────────────────────────────────────────
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webuillm-e2e-'));
const flask = spawn('python', ['server.py'], {
  cwd: PROJ,
  env: {
    ...process.env,
    PORT: String(FLASK_PORT),
    HOST: '127.0.0.1',
    // третий сервер никто не слушает — он должен быть виден как «нет связи»;
    // четвёртый — речевая модель, её тип прокси узнаёт сам
    LM_BACKEND: `http://127.0.0.1:${LLM_PORT}, http://127.0.0.1:${LLM2_PORT}/, http://127.0.0.1:${DEAD_PORT}, http://127.0.0.1:${ASR_PORT}`,
    LM_REGISTRY: '',
    APP_DB_PATH: path.join(dbDir, 'e2e.db'),
    PYTHONIOENCODING: 'utf-8',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
flask.stdout.on('data', (d) => serverLog.push(String(d)));
flask.stderr.on('data', (d) => serverLog.push(String(d)));

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/auth/me');
      if (r.status === 401 || r.ok) return true;
    } catch { /* ещё не поднялся */ }
    await sleep(250);
  }
  return false;
}

function shutdown(code) {
  flask.kill();
  llm.close();
  llm2.close();
  asr.close();
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* занято — не страшно */ }
  process.exit(code);
}

if (!await waitUp()) {
  console.error('Сервер не поднялся:\n' + serverLog.join(''));
  shutdown(1);
}

// ── jsdom с настоящей сетью и банкой для кук ────────────────────────────────
let cookie = '';
async function netFetch(input, init = {}) {
  const url = new URL(String(input), BASE).toString();
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set('cookie', cookie);

  // Кнопка «Стоп» отдаёт AbortSignal из jsdom, а node-овый fetch принимает
  // только свой — перекладываем отмену на посредника.
  let signal;
  if (init.signal) {
    const relay = new AbortController();
    if (init.signal.aborted) relay.abort();
    else init.signal.addEventListener('abort', () => relay.abort());
    signal = relay.signal;
  }

  const r = await fetch(url, { ...init, headers, signal, redirect: 'manual' });
  for (const c of (r.headers.getSetCookie?.() || [])) {
    const pair = c.split(';')[0];
    cookie = pair.endsWith('=') ? '' : pair;   // пустое значение = кука снята
  }
  return r;
}

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.message));
vc.on('error', (...a) => errors.push(a.join(' ')));

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const bundleName = fs.readdirSync(path.join(DIST, 'assets')).find((f) => f.endsWith('.js'));
const bundle = fs.readFileSync(path.join(DIST, 'assets', bundleName), 'utf8');

async function open(url = '/') {
  const dom = new JSDOM(html, {
    url: BASE + url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  window.fetch = netFetch;
  window.confirm = () => true;          // удаление чата спрашивает подтверждение
  const el = window.document.createElement('script');
  el.textContent = bundle;
  window.document.body.appendChild(el);
  await sleep(600);
  return window;
}

function type(window, el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

try {
  // ── Вход обязателен ───────────────────────────────────────────────────────
  let w = await open('/');
  let doc = w.document;
  check('без входа показан экран входа', !!doc.querySelector('.auth-card'));
  check('чат без входа не показывается', !doc.querySelector('.composer'));
  check('форма предлагает регистрацию', (doc.body.textContent || '').includes('Зарегистрироваться'));

  // Регистрация с коротким паролем — ошибка с сервера
  click(w, doc.querySelector('.auth-switch'));
  await sleep(60);
  type(w, doc.querySelectorAll('.auth-field input')[0], 'tester');
  type(w, doc.querySelectorAll('.auth-field input')[1], '123');
  await sleep(40);
  click(w, doc.querySelector('.auth-submit'));
  await sleep(400);
  check('короткий пароль отклонён с понятным текстом',
    (doc.querySelector('.auth-error')?.textContent || '').includes('Пароль'),
    JSON.stringify(doc.querySelector('.auth-error')?.textContent));

  // Нормальная регистрация
  type(w, doc.querySelectorAll('.auth-field input')[1], 'пароль-подлиннее');
  await sleep(40);
  click(w, doc.querySelector('.auth-submit'));
  await sleep(900);
  check('после регистрации открылся чат', !!doc.querySelector('.composer textarea'));
  check('имя пользователя видно в панели',
    (doc.querySelector('.sb-user-name')?.textContent || '') === 'tester');

  // ── Панель: ни хоста, ни токена ───────────────────────────────────────────
  const sidebarText = doc.querySelector('.sidebar')?.textContent || '';
  check('в панели нет поля «Хост»', !sidebarText.includes('Хост'));
  check('в панели нет поля «API токен»', !sidebarText.includes('API токен'));
  check('поля пароля в панели нет', doc.querySelectorAll('.sidebar input[type=password]').length === 0);
  check('есть кнопка «Новый чат»', !!doc.querySelector('.new-chat'));
  check('список чатов пуст', (doc.querySelector('.chat-empty')?.textContent || '').includes('пока нет'));

  // Настройки свёрнуты, но открываются
  check('настройки свёрнуты по умолчанию', !doc.querySelector('.sb-settings .sb-body'));
  click(w, doc.querySelector('.settings-toggle'));
  await sleep(80);
  check('настройки раскрываются', !!doc.querySelector('.sb-settings .sb-body'));
  const modelSelect = () => doc.querySelector('.sb-settings select.si');
  check('модель подтянулась с бэкенда', modelSelect()?.value === 'test-model #1', modelSelect()?.value);
  const optionsText = () => [...(modelSelect()?.options || [])].map((o) => o.textContent).join(',');
  check('в списке модели всех серверов, у каждой — порт',
    optionsText() === `test-model · :${LLM_PORT},second-model · :${LLM2_PORT},test-model · :${LLM2_PORT},🎙 asr-model · :${ASR_PORT},:${DEAD_PORT} — нет связи`,
    optionsText());
  check('молчащий сервер — неактивной строкой',
    [...(modelSelect()?.options || [])].find((o) => o.textContent.includes('нет связи'))?.disabled === true);
  check('статус подсказывает, с кем нет связи',
    (doc.querySelector('.sidebar')?.textContent || '').includes(`нет связи с :${DEAD_PORT}`));
  click(w, doc.querySelector('.settings-toggle'));
  await sleep(60);

  // ── Переписка ─────────────────────────────────────────────────────────────
  type(w, doc.querySelector('.composer textarea'), 'Первый вопрос про хранение чатов');
  await sleep(60);
  click(w, doc.querySelector('.send-btn'));
  await sleep(1200);

  check('ответ модели дошёл через прокси',
    (doc.querySelectorAll('.msg')[1]?.textContent || '').includes('Ответ на 1 реплик'),
    JSON.stringify((doc.querySelectorAll('.msg')[1]?.textContent || '').slice(0, 40)));
  check('ответ отрисован как Markdown',
    doc.querySelectorAll('.msg')[1]?.querySelector('.md strong')?.textContent === 'Ответ',
    doc.querySelectorAll('.msg')[1]?.innerHTML.slice(0, 120));
  const meter = () => (doc.querySelector('.ctx-meter')?.textContent || '').replace(/\s+/g, ' ');
  check('контекст сессии — из usage ответа', meter().includes('Контекст: 105 / 4 096'), meter());
  check('видно, сколько слотов на сервере', meter().includes('из 2'), meter());
  const stats1 = doc.querySelectorAll('.msg')[1]?.querySelector('.msg-stats')?.textContent || '';
  check('статистика токенов у ответа', stats1.includes('↓5'), stats1);
  check('скорость инференса у ответа', stats1.includes('42.5 ток/с') && stats1.includes('промпт 900'), stats1);
  const block = doc.querySelectorAll('.msg')[1]?.querySelector('.md-code');
  check('длинный блок кода свёрнут', !!block?.classList.contains('collapsed'));
  check('у блока кода есть «Скачать»',
    [...(block?.querySelectorAll('button') || [])].some((b) => b.textContent.includes('Скачать')));
  click(w, block.querySelector('.md-code-more'));
  await sleep(60);
  check('блок кода разворачивается', !block.classList.contains('collapsed'));
  check('чат появился в списке', doc.querySelectorAll('.chat-item').length === 1,
    'чатов=' + doc.querySelectorAll('.chat-item').length);
  check('чат назван по первой реплике',
    (doc.querySelector('.chat-title')?.textContent || '').startsWith('Первый вопрос'),
    doc.querySelector('.chat-title')?.textContent);

  // Вторая реплика — модель должна получить историю
  type(w, doc.querySelector('.composer textarea'), 'Второй вопрос');
  await sleep(60);
  click(w, doc.querySelector('.send-btn'));
  await sleep(1200);
  check('история дошла до модели (3 реплики)',
    (lastLlmBody.messages || []).length === 3,
    'реплик=' + (lastLlmBody.messages || []).length);
  check('роли в истории верные',
    lastLlmBody.messages.map((m) => m.role).join(',') === 'user,assistant,user');
  check('в ленте четыре сообщения', doc.querySelectorAll('.msg').length === 4,
    'сообщений=' + doc.querySelectorAll('.msg').length);

  // ── Переписка переживает перезагрузку страницы ────────────────────────────
  w = await open('/');
  doc = w.document;
  check('после перезагрузки вход не требуется', !!doc.querySelector('.composer textarea'));
  check('прежний чат на месте в списке', doc.querySelectorAll('.chat-item').length === 1);
  check('при загрузке показан пустой новый чат', doc.querySelectorAll('.msg').length === 0);

  click(w, doc.querySelector('.chat-item'));
  await sleep(600);
  check('переписка восстановилась с сервера', doc.querySelectorAll('.msg').length === 4,
    'сообщений=' + doc.querySelectorAll('.msg').length);
  check('текст первой реплики сохранился',
    (doc.querySelectorAll('.msg')[0].textContent || '').includes('Первый вопрос про хранение'));
  check('кириллица в сохранённой переписке цела',
    !(doc.querySelectorAll('.msg')[0].textContent || '').includes('�'));
  // 5 + 66 + 2 + 66 слов (ответ — фраза и 20 строк кода) — токенайзер подделки считает словами
  const meterText = (doc.querySelector('.ctx-meter')?.textContent || '').replace(/\s+/g, ' ');
  check('контекст сохранённого чата пересчитан бэкендом', meterText.includes('Контекст: 139 / 4 096'), meterText);
  check('скорость ответа сохранилась в переписке',
    (doc.querySelectorAll('.msg')[1].querySelector('.msg-stats')?.textContent || '').includes('42.5 ток/с'));

  // ── Второй чат ────────────────────────────────────────────────────────────
  click(w, doc.querySelector('.new-chat'));
  await sleep(120);
  check('новый чат очищает ленту', doc.querySelectorAll('.msg').length === 0);
  type(w, doc.querySelector('.composer textarea'), 'Отдельная тема');
  await sleep(60);
  click(w, doc.querySelector('.send-btn'));
  await sleep(1200);
  check('чатов стало два', doc.querySelectorAll('.chat-item').length === 2,
    'чатов=' + doc.querySelectorAll('.chat-item').length);
  check('новый чат не унаследовал чужую историю',
    (lastLlmBody.messages || []).length === 1,
    'реплик=' + (lastLlmBody.messages || []).length);

  // ── Переключение на модель второго сервера ────────────────────────────────
  click(w, doc.querySelector('.settings-toggle'));
  await sleep(80);
  const sel = doc.querySelector('.sb-settings select.si');
  Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value').set.call(sel, 'second-model');
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(900);
  check('в шапке — имя модели и порт',
    doc.querySelector('.tb-model')?.textContent === `second-model · :${LLM2_PORT}`, doc.querySelector('.tb-model')?.textContent);
  const meter2 = (doc.querySelector('.ctx-meter')?.textContent || '').replace(/\s+/g, ' ');
  check('лимит контекста — со второго сервера', meter2.includes('/ 8 192'), meter2);
  type(w, doc.querySelector('.composer textarea'), 'Вопрос второй модели');
  await sleep(60);
  click(w, doc.querySelector('.send-btn'));
  await sleep(1200);
  check('запрос ушёл на второй сервер',
    lastLlm2Body?.model === 'second-model' && (doc.querySelector('.log')?.textContent || '').includes('Вторая модель ответила'),
    JSON.stringify(lastLlm2Body?.model));

  // Та же модель на втором сервере — отдельный экземпляр, не склеенный с первым
  const pick = (value) => {
    const s = doc.querySelector('.sb-settings select.si');
    Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value').set.call(s, value);
    s.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  pick('test-model #2');
  await sleep(300);
  lastLlm2Body = null;
  lastLlmBody = null;
  type(w, doc.querySelector('.composer textarea'), 'Вопрос второму экземпляру');
  await sleep(60);
  click(w, doc.querySelector('.send-btn'));
  await sleep(1200);
  check('«test-model #2» ушёл на второй сервер под настоящим именем',
    lastLlm2Body?.model === 'test-model' && lastLlmBody === null,
    JSON.stringify({ второй: lastLlm2Body?.model, первый: lastLlmBody?.model }));
  pick('test-model #1');
  await sleep(300);
  type(w, doc.querySelector('.composer textarea'), 'Вопрос первому экземпляру');
  await sleep(60);
  lastLlm2Body = null;
  click(w, doc.querySelector('.send-btn'));
  await sleep(1200);
  check('«test-model #1» ушёл на первый сервер',
    lastLlmBody?.model === 'test-model' && lastLlm2Body === null,
    JSON.stringify({ первый: lastLlmBody?.model, второй: lastLlm2Body?.model }));

  // ── Распознавание речи ────────────────────────────────────────────────────
  // Системный промпт задан — речевой модели он уйти не должен.
  type(w, doc.querySelector('.sb-settings textarea.sta'), 'Отвечай кратко');
  await sleep(60);
  pick('asr-model');
  await sleep(400);
  check('у речевой модели поле ввода выключено', doc.querySelector('.composer textarea')?.disabled === true);
  check('у речевой модели есть скрепка', !!doc.querySelector('.composer .attach-btn'));
  check('у речевой модели нет счётчика контекста', !doc.querySelector('.ctx-meter'));
  check('без записи отправить нельзя', doc.querySelector('.send-btn')?.disabled === true);
  const fileInput = doc.querySelector('.composer input[type=file]');
  Object.defineProperty(fileInput, 'files', {
    value: [new w.File([toneWav()], 'звонок.wav', { type: 'audio/wav' })], configurable: true,
  });
  fileInput.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(300);
  check('запись приложена', (doc.querySelector('.attach-chip')?.textContent || '').includes('звонок.wav'));
  const msgsBefore = doc.querySelectorAll('.msg').length;
  click(w, doc.querySelector('.send-btn'));
  await sleep(1800);
  const parts = lastAsrBody?.messages?.[0]?.content || [];
  check('речевой модели ушла одна запись — без истории и системного промпта',
    lastAsrBody?.messages?.length === 1 && lastAsrBody.messages[0].role === 'user',
    JSON.stringify(lastAsrBody?.messages?.map((m) => m.role)));
  check('рядом с записью нет текста', parts.length === 1 && parts[0].type === 'audio_url',
    JSON.stringify(parts.map((p) => p.type)));
  check('модель ушла под своим именем, потоком', lastAsrBody?.model === 'asr-model' && lastAsrBody?.stream === true);
  if (HAS_FFMPEG) {
    check('прокси привёл запись к WAV 16 кГц моно',
      lastAsrWav?.mime === 'audio/wav' && lastAsrWav.rate === 16000 && lastAsrWav.channels === 1,
      JSON.stringify(lastAsrWav));
  }
  const asrMsg = [...doc.querySelectorAll('.msg')].pop();
  const tr = asrMsg?.querySelector('.bbl.transcript')?.textContent || '';
  check('в ленте — реплика с записью и расшифровка', doc.querySelectorAll('.msg').length === msgsBefore + 2);
  check('реплика с записью — строкой с именем файла',
    (doc.querySelectorAll('.msg')[msgsBefore]?.textContent || '').includes('🎙 звонок.wav'));
  check('петля, откаченная discard, стёрта', tr.includes('Привет\n') && !tr.includes('мир'), JSON.stringify(tr));
  check('таймкоды второго окна — от начала записи',
    tr.includes('[00:01.0 - 00:02.0]') && tr.includes('[01:33.5 - 01:35.0]'), JSON.stringify(tr));
  check('расшифровка показана как есть, с [note]', tr.includes('[note]:\nSpeaker 1, male'), JSON.stringify(tr));
  const asrStats = asrMsg?.querySelector('.msg-stats')?.textContent || '';
  check('у расшифровки длина записи и RTF', asrStats.includes('🎙 1 мин 35 с') && asrStats.includes('RTF 0.50'), asrStats);
  check('после отправки запись снята', !doc.querySelector('.attach-chip'));

  // Расшифровку можно обсудить с чат-моделью: она придёт в истории.
  pick('test-model #1');
  await sleep(400);
  check('у чат-модели поле ввода снова работает', doc.querySelector('.composer textarea')?.disabled === false);
  check('у чат-модели без звука скрепки нет', !doc.querySelector('.composer .attach-btn'));
  type(w, doc.querySelector('.composer textarea'), 'Перескажи запись');
  await sleep(60);
  click(w, doc.querySelector('.send-btn'));
  await sleep(1200);
  const hist = lastLlmBody?.messages || [];
  check('чат-модель видит расшифровку и системный промпт',
    hist[0]?.role === 'system' && hist.some((m) => m.role === 'assistant' && String(m.content).includes('Второе окно')),
    JSON.stringify(hist.map((m) => m.role)));
  type(w, doc.querySelector('.sb-settings textarea.sta'), '');
  await sleep(60);

  // Расшифровка переживает перезагрузку и остаётся расшифровкой.
  w = await open('/');
  doc = w.document;
  click(w, doc.querySelector('.chat-item'));
  await sleep(700);
  const saved = [...doc.querySelectorAll('.msg.assistant')].find((m) => m.querySelector('.bbl.transcript'));
  check('сохранённая расшифровка показана как есть',
    (saved?.querySelector('.bbl.transcript')?.textContent || '').includes('[01:33.5 - 01:35.0]'));
  check('у сохранённой расшифровки RTF', (saved?.querySelector('.msg-stats')?.textContent || '').includes('RTF 0.50'));

  // ── Переименование и удаление ─────────────────────────────────────────────
  const item = doc.querySelector('.chat-item');
  item.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await sleep(100);
  const renameInput = doc.querySelector('.chat-rename');
  check('двойной щелчок включает переименование', !!renameInput);
  type(w, renameInput, 'Переименованный');
  renameInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(600);
  check('чат переименован',
    [...doc.querySelectorAll('.chat-title')].some((e) => e.textContent === 'Переименованный'),
    [...doc.querySelectorAll('.chat-title')].map((e) => e.textContent).join(' | '));

  click(w, doc.querySelector('.chat-item .chat-del'));
  await sleep(700);
  check('чат удалён', doc.querySelectorAll('.chat-item').length === 1,
    'осталось=' + doc.querySelectorAll('.chat-item').length);

  // ── Выход ─────────────────────────────────────────────────────────────────
  click(w, doc.querySelector('.sb-user .icon-btn'));
  await sleep(500);
  check('после выхода снова экран входа', !!doc.querySelector('.auth-card'));
  check('после выхода API закрыт', (await netFetch('/api/chats')).status === 401);
  check('после выхода прокси закрыт', (await netFetch('/v1/models')).status === 401);

  check('без ошибок в консоли страницы', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  console.error('\nПРОГОН ОБОРВАЛСЯ:', e);
  fails.push('исключение в прогоне');
}

console.log('\nИТОГ: упало ' + fails.length + (fails.length ? ' → ' + fails.join(', ') : ''));
if (fails.length) console.log('\nлог сервера:\n' + serverLog.join('').slice(-2000));
shutdown(fails.length ? 1 : 0);
