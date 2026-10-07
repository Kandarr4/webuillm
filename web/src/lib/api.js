// ════════════════════════════════════════════════════════════════════════════
// Сетевой слой. Браузер всегда говорит со своим Flask-сервером (origin), а он
// проксирует /v1/* и /api/* на бэкенд — CORS и адрес бэкенда спрятаны за
// прокси (см. server.py, переменная LM_BACKEND).
// ════════════════════════════════════════════════════════════════════════════

import { genParams } from './settings.js';

const CHAT_URL = '/v1/chat/completions';


// Текст ошибки из тела ответа — сервер отдаёт то {"error": {...}}, то plain.
async function httpError(r) {
  let body = await r.text().catch(() => '');
  try {
    const j = JSON.parse(body);
    if (j?.error) body = j.error.message || String(j.error);
  } catch { /* не JSON — оставляем как есть */ }
  return new Error('HTTP ' + r.status + (body ? ': ' + body : ''));
}

// ── Разбор SSE ──────────────────────────────────────────────────────────────
// Кадры разделены пустой строкой. Нормализуем CRLF: прокси переносят строки
// по-разному, а разбор по строгому '\n\n' на CRLF-потоке молча копил буфер.
async function* sseFrames(response, signal) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = frame.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) continue;
        // Обычный SSE — строки «data: …». Бэкенд местами шлёт голый JSON.
        const data = lines.some((l) => l.startsWith('data:'))
          ? lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
          : lines.join('\n');
        if (data) yield data;
      }
    }
  } finally {
    // Прерывание по «Стоп»: закрываем reader, иначе соединение течёт.
    if (signal?.aborted) reader.cancel().catch(() => {});
  }
}

// ── Модели / проверка связи ─────────────────────────────────────────────────
// { models: [{ id, name, server, kind, input }], servers: [{ server, ok }] }.
// id — то, что уходит в запрос («qwen #2» у второго экземпляра), name —
// настоящее имя модели, server — метка сервера («:8081»), kind — 'asr'
// (речевая модель: аудио → расшифровка) или 'llm', input — что модель
// принимает ('audio', 'text'). servers — все известные серверы, включая те,
// что сейчас не отвечают.
export async function listModels(force = false) {
  try {
    // force — опросить серверы сейчас, а не отдать список из кэша прокси.
    const r = await fetch('/v1/models' + (force ? '?refresh=1' : ''));
    if (r.ok) {
      const j = await r.json();
      if (j.data?.length || j.servers?.length) {
        return {
          models: (j.data || []).map((m) => ({
            id: m.id,
            name: m.name || m.id,
            server: m.server || '',
            kind: m.kind === 'asr' ? 'asr' : 'llm',
            input: Array.isArray(m.input) ? m.input : ['text'],
          })),
          servers: j.servers || [],
        };
      }
    }
  } catch { /* пробуем следующий диалект */ }
  try {
    const r = await fetch('/api/v1/models');
    if (r.ok) {
      const j = await r.json();
      if (j.models?.length) {
        return {
          models: j.models.map((m) => ({ id: m.id || m.key, name: m.id || m.key, server: '', kind: 'llm', input: ['text'] })),
          servers: [],
        };
      }
    }
  } catch { /* связи нет */ }
  return { models: [], servers: [] };
}

// «gemma4-26b-a4b · :8081» — как модель подписана в интерфейсе; речевая —
// с микрофоном: «🎙 069-bf16-q4 · :8000».
export function modelLabel(models, id) {
  const m = models.find((x) => x.id === id);
  if (!m) return id;
  const name = (m.kind === 'asr' ? '🎙 ' : '') + m.name;
  return m.server ? `${name} · ${m.server}` : name;
}

export const findModel = (models, id) => models.find((m) => m.id === id) || null;

// ── Аудио ───────────────────────────────────────────────────────────────────
// Прокси приводит любую запись к WAV 16 кГц моно через ffmpeg и формат узнаёт
// по MIME из data-URI. Браузер не знает .spx и ставит пустой тип — берём тип
// по расширению.
const AUDIO_MIME = {
  wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/mp4',
  spx: 'audio/spx',
};
export const AUDIO_ACCEPT = 'audio/*,' + Object.keys(AUDIO_MIME).map((e) => '.' + e).join(',');

export function readAudioFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('не удалось прочитать файл'));
    reader.onload = () => {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const mime = file.type.startsWith('audio/') ? file.type : (AUDIO_MIME[ext] || 'application/octet-stream');
      const b64 = String(reader.result).split(',', 2)[1] || '';
      resolve({ name: file.name, size: file.size, dataUrl: `data:${mime};base64,${b64}` });
    };
    reader.readAsDataURL(file);
  });
}

// ── Чат ─────────────────────────────────────────────────────────────────────
// Сообщения в том виде, в каком уходят модели: системный промпт + история.
// Речевой модели это не годится — ей уходит одна запись (см. streamAsr).
export function buildMessages(history, settings) {
  const messages = [];
  const system = settings.system.trim();
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...history);
  return messages;
}

// Отдаёт события по мере генерации:
//   { type: 'delta', text } — кусок ответа;
//   { type: 'stats', stats } — токены и скорость: по ходу генерации и итог.
//     stats = { prompt, completion, cached, tps, pps }: токены запроса (вся
//     переписка), ответа и взятые из кэша; скорость генерации и обработки
//     промпта, ток/с. Неизвестное — null.
// Рассуждения, которые бэкенд шлёт отдельным полем reasoning_content,
// заворачиваются в <think>…</think> — так же, как их отдаёт llama.cpp без
// разбора, и интерфейс показывает их одинаково.
// audio — data-URI записи для модели, которая принимает звук, но отвечает
// как обычный чат: запись уходит частью последней реплики.
export async function* streamChat({ history, settings, signal, audio }) {
  const messages = buildMessages(history, settings);
  const last = messages[messages.length - 1];
  if (audio && last?.role === 'user') {
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        ...(last.content ? [{ type: 'text', text: last.content }] : []),
        { type: 'audio_url', audio_url: { url: audio } },
      ],
    };
  }
  const r = await fetch(CHAT_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model.trim(),
      messages,
      stream: true,
      // Без этого OpenAI-совместимые бэкенды не присылают usage в стриме.
      stream_options: { include_usage: true },
      // llama.cpp: timings в каждом кадре, а не только в последнем, — скорость
      // видна прямо во время генерации. Остальные бэкенды поле игнорируют.
      timings_per_token: true,
      ...genParams(settings),
    }),
  });
  if (!r.ok || !r.body) throw await httpError(r);

  let inThink = false;
  const st = { prompt: null, completion: null, cached: null, tps: null, pps: null };
  // Запасной счёт по часам браузера — для бэкендов без timings: кадр с
  // текстом ≈ токен, скорость — от первого кадра.
  let chunks = 0;
  let tFirst = 0;
  const clockTps = () => {
    const sec = (performance.now() - tFirst) / 1000;
    const n = (st.completion ?? chunks) - 1;
    return tFirst && sec > 0.3 && n > 0 ? n / sec : null;
  };
  let serverTps = false;

  for await (const data of sseFrames(r, signal)) {
    if (data === '[DONE]') break;
    let j;
    try { j = JSON.parse(data); } catch { continue; }   // служебный кадр

    const delta = j.choices?.[0]?.delta || {};
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning || delta.content) {
      chunks++;
      if (!tFirst) tFirst = performance.now();
    }
    if (reasoning) {
      yield { type: 'delta', text: (inThink ? '' : '<think>') + reasoning };
      inThink = true;
    }
    if (delta.content) {
      yield { type: 'delta', text: (inThink ? '</think>\n\n' : '') + delta.content };
      inThink = false;
    }

    // usage — стандарт OpenAI; timings — llama.cpp.
    const u = j.usage;
    const t = j.timings;
    if (t) {
      st.prompt = (t.prompt_n || 0) + (t.cache_n || 0);
      st.cached = t.cache_n ?? st.cached;
      st.completion = t.predicted_n ?? st.completion;
      // На первом токене llama.cpp отдаёт скорость 0 — пропускаем.
      if (t.predicted_n > 1 && t.predicted_per_second > 0) { st.tps = t.predicted_per_second; serverTps = true; }
      if (t.prompt_n > 0 && t.prompt_per_second > 0) st.pps = t.prompt_per_second;
    }
    if (u) {
      st.prompt = u.prompt_tokens ?? st.prompt;
      st.completion = u.completion_tokens ?? st.completion;
      st.cached = u.prompt_tokens_details?.cached_tokens ?? st.cached;
    }
    if (!serverTps) st.tps = clockTps();
    if (t || u || chunks % 8 === 0) yield { type: 'stats', stats: { ...st } };
  }
  if (inThink) yield { type: 'delta', text: '</think>' };
  if (!serverTps) st.tps = clockTps();
  yield { type: 'stats', stats: { ...st } };
}

// ── Распознавание речи ──────────────────────────────────────────────────────
// Таймкоды в расшифровке отсчитываются от начала своего окна (сервер режет
// запись на окна по ~90 с), а начало окна в записи приходит отдельным
// событием. Сдвигаем их, чтобы читались от начала записи.
const TIMECODE = /\[(\d+):(\d+(?:\.\d+)?) - (\d+):(\d+(?:\.\d+)?)\]/g;

function fmtTimecode(sec) {
  const t = Math.round(sec * 10);             // десятые доли секунды
  const m = Math.floor(t / 600);
  const s = (t % 600) / 10;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export function shiftTimecodes(text, offset) {
  if (!offset) return text;
  return text.replace(TIMECODE, (_, m1, s1, m2, s2) => (
    `[${fmtTimecode(+m1 * 60 + +s1 + offset)} - ${fmtTimecode(+m2 * 60 + +s2 + offset)}]`
  ));
}

// Расшифровка целиком: raw — текст, как его прислал сервер; windows —
// [{ at, start }]: с какого символа raw начинается окно и с какой секунды
// записи. Кусок до первого окна (его может и не быть) — как есть.
export function transcriptText(raw, windows) {
  if (!windows.length) return raw;
  let out = raw.slice(0, windows[0].at);
  windows.forEach((w, i) => {
    const end = i + 1 < windows.length ? windows[i + 1].at : raw.length;
    out += shiftTimecodes(raw.slice(w.at, end), w.start);
  });
  return out;
}

// Запись → расшифровка. Модель учили на одной записи без системного промпта,
// без истории и без текста рядом — поэтому уходит только она: свой промпт
// сервер подставит сам.
//
// Поток у ASR-сервера — не OpenAI: события { type: stage | info | window |
// delta | discard | metrics | done | error }. discard — сторож оборвал петлю:
// последние chars символов уже показанного текста надо стереть.
//
// Отдаёт события:
//   { type: 'text', text } — расшифровка целиком на этот момент;
//   { type: 'stage', text } — что сервер делает сейчас («Окно 2 из 5»);
//   { type: 'stats', stats } — { tps, completion, prompt, audio, infer, rtf }.
export async function* streamAsr({ model, audio, signal }) {
  const r = await fetch(CHAT_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'audio_url', audio_url: { url: audio } }] }],
    }),
  });
  if (!r.ok || !r.body) throw await httpError(r);

  let raw = '';
  const windows = [];
  // Готовые окна не меняются — их текст со сдвигом считаем один раз, а на
  // каждый кусок пересчитываем только текущее окно: у часовой записи
  // расшифровка на десятки тысяч символов.
  let frozen = { count: 0, upto: 0, text: '' };
  const text = () => {
    const cur = windows[windows.length - 1];
    if (!cur) return raw;
    if (frozen.count !== windows.length - 1 || frozen.upto !== cur.at) {
      frozen = {
        count: windows.length - 1,
        upto: cur.at,
        text: transcriptText(raw.slice(0, cur.at), windows.slice(0, -1)),
      };
    }
    return frozen.text + shiftTimecodes(raw.slice(cur.at), cur.start);
  };
  const st = { tps: null, completion: null, prompt: null, audio: null, infer: null, rtf: null };
  const num = (v) => (Number.isFinite(v) ? v : null);

  for await (const data of sseFrames(r, signal)) {
    if (data === '[DONE]') break;
    let j;
    try { j = JSON.parse(data); } catch { continue; }

    switch (j.type) {
      case 'stage':
        yield { type: 'stage', text: j.text || '' };
        break;
      case 'info':
        st.audio = num(j.audio_sec) ?? st.audio;
        yield { type: 'stats', stats: { ...st } };
        break;
      case 'window':
        windows.push({ at: raw.length, start: num(j.start_sec) ?? 0 });
        yield { type: 'stage', text: j.total > 1 ? `Окно ${j.index} из ${j.total}` : '' };
        break;
      case 'delta':
        raw += j.text || '';
        yield { type: 'text', text: text() };
        break;
      case 'discard': {
        const n = Math.max(0, Math.floor(j.chars) || 0);
        raw = raw.slice(0, Math.max(0, raw.length - n));
        for (const w of windows) if (w.at > raw.length) w.at = raw.length;
        yield { type: 'text', text: text() };
        break;
      }
      case 'metrics':
        st.tps = num(j.tok_per_sec) ?? st.tps;
        st.completion = num(j.tokens) ?? st.completion;
        yield { type: 'stats', stats: { ...st } };
        break;
      case 'done':
        st.audio = num(j.audio_sec) ?? st.audio;
        st.infer = num(j.inference_sec);
        st.rtf = num(j.rtf);
        st.prompt = num(j.prompt_tokens) ?? st.prompt;
        st.completion = num(j.completion_tokens) ?? st.completion;
        yield { type: 'stats', stats: { ...st } };
        break;
      case 'error':
        throw new Error(j.message || 'ошибка сервера распознавания');
      default: {
        // Обычный OpenAI-кадр — сервер без ASR-обёртки.
        const c = j.choices?.[0]?.delta?.content;
        if (c) { raw += c; yield { type: 'text', text: text() }; }
      }
    }
  }
  yield { type: 'text', text: text() };
}

// ── Контекст модели ─────────────────────────────────────────────────────────
// Сколько токенов даёт сервер на сессию и сколько займёт переписка. Сбой —
// не ошибка интерфейса: вернём «не знаем» (null), и счётчик покажет оценку.
export const llmApi = {
  async limits(model) {
    try {
      const r = await fetch('/api/llm/limits?model=' + encodeURIComponent(model || ''));
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  },
  async count(messages, settings, signal) {
    try {
      const r = await fetch('/api/llm/count', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.model.trim(),
          messages,
          chat_template_kwargs: genParams(settings).chat_template_kwargs,
        }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return Number.isFinite(j.tokens) ? j.tokens : null;
    } catch {
      return null;
    }
  },
};

// ── Локальная обработка ─────────────────────────────────────────────────────
// Эндпоинты переехали под /api/local/*, чтобы путь /local остался за страницей
// React-роутера (старые /local/* сервер тоже понимает — см. server.py).
const LOCAL = '/api/local';

async function localPost(path, body) {
  const r = await fetch(LOCAL + path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw await httpError(r);
  return r.json();
}

export const localApi = {
  async status(signal) {
    const r = await fetch(LOCAL + '/status', { signal });
    if (!r.ok) throw await httpError(r);
    return r.json();
  },
  start: () => localPost('/start'),
  stop: () => localPost('/stop'),
  rescan: () => localPost('/rescan'),
  config: (cfg) => localPost('/config', cfg),
  xlsxUrl: (pkg) => `${LOCAL}/xlsx/${encodeURIComponent(pkg)}`,
};

// ── Учётные записи ──────────────────────────────────────────────────────────
// Сессия живёт в httponly-куке: JavaScript её не видит и не хранит.
async function authPost(path, body) {
  const r = await fetch('/api/auth' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

export const authApi = {
  // 401 здесь — не ошибка, а «не вошёл»: отличаем его от обрыва сети.
  async me() {
    const r = await fetch('/api/auth/me');
    const j = await r.json().catch(() => ({}));
    return { user: j.user || null, allowRegistration: j.allow_registration !== false };
  },
  login: (username, password) => authPost('/login', { username, password }),
  register: (username, password) => authPost('/register', { username, password }),
  logout: () => authPost('/logout'),
};

// ── Чаты ────────────────────────────────────────────────────────────────────
async function chatsReq(path, options) {
  const r = await fetch('/api/chats' + path, {
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

export const chatsApi = {
  list: async () => (await chatsReq('')).chats,
  create: async (title) => (await chatsReq('', {
    method: 'POST', body: JSON.stringify({ title: title || '' }),
  })).chat,
  get: async (id) => (await chatsReq('/' + id)).chat,
  rename: async (id, title) => (await chatsReq('/' + id, {
    method: 'PATCH', body: JSON.stringify({ title }),
  })).chat,
  remove: (id) => chatsReq('/' + id, { method: 'DELETE' }),
  addMessage: async (id, role, content, stats) => (await chatsReq('/' + id + '/messages', {
    method: 'POST', body: JSON.stringify({ role, content, stats: stats || null }),
  })).message,
  editMessage: async (id, msgId, content) => (await chatsReq(`/${id}/messages/${msgId}`, {
    method: 'PATCH', body: JSON.stringify({ content }),
  })).message,
  // Удаляет реплику msgId и всё после неё.
  truncateFrom: (id, msgId) => chatsReq(`/${id}/messages/${msgId}/and-after`, { method: 'DELETE' }),
};
