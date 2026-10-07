// ════════════════════════════════════════════════════════════════════════════
// Чат с моделью. Переписка хранится на сервере: список чатов и реплики
// переживают перезагрузку страницы и доступны только своему владельцу.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import Composer from '../components/Composer.jsx';
import ContextMeter from '../components/ContextMeter.jsx';
import Message from '../components/Message.jsx';
import ModelBadge from '../components/ModelBadge.jsx';
import Sidebar from '../components/Sidebar.jsx';
import { Menu } from '../components/Icons.jsx';
import {
  buildMessages, chatsApi, findModel, listModels, llmApi, modelLabel, readAudioFile, streamAsr, streamChat,
} from '../lib/api.js';
import { uid } from '../lib/format.js';
import { useSettings } from '../lib/settings.js';
import { useToast } from '../lib/toast.jsx';

const SB_KEY = 'webuillm_sidebar_collapsed';
const RENDER_MS = 40;   // не чаще, чем раз в 40 мс перерисовывать растущий ответ

// То, что уйдёт модели следующим запросом (без новой реплики): по этому
// считается заполненность контекста. Правила те же, что при отправке.
function ctxMessages(list, settings) {
  const clean = list.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
  return buildMessages(settings.chatHistory ? clean : clean.slice(-2), settings);
}

// Когда бэкенд не умеет считать токены: грубо, ~3 символа на токен для
// смеси русского и английского, плюс служебные токены шаблона на реплику.
function estimateTokens(messages) {
  return messages.reduce((n, m) => n + Math.ceil(m.content.length / 3) + 4, 0);
}

export default function ChatPage({ theme, onTheme, user, onLogout, onUnauthorized }) {
  const [settings, set] = useSettings();
  const [chats, setChats] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState({ state: 'off', text: 'не подключено' });
  const [models, setModels] = useState([]);                // [{ id, name, server, kind, input }]
  const [servers, setServers] = useState([]);              // [{ server, ok }]
  const [limits, setLimits] = useState(null);             // что даёт сервер на сессию
  const [ctx, setCtx] = useState(null);                   // { used, exact } — занято в этом чате
  const [counting, setCounting] = useState(false);
  const [audio, setAudio] = useState(null);               // приложенная запись { name, size, dataUrl }
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SB_KEY) === '1'; } catch { return false; }
  });

  const toast = useToast();
  const logRef = useRef(null);
  const stick = useRef(true);
  const abortRef = useRef(null);
  const detectSeq = useRef(0);
  const countSeq = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    try { localStorage.setItem(SB_KEY, collapsed ? '1' : '0'); } catch { /* приватный режим */ }
  }, [collapsed]);

  // Что умеет выбранная модель: речевая (asr) принимает только запись и
  // отвечает расшифровкой; скрепка — у всех, кто принимает звук.
  const current = findModel(models, settings.model);
  const isAsr = current?.kind === 'asr';
  const canAttach = !!current?.input.includes('audio');

  // Модель сменили на ту, что звук не принимает, — запись ей не уйдёт.
  useEffect(() => {
    if (!canAttach && !streaming) setAudio(null);
  }, [canAttach, streaming]);

  async function attachAudio(file) {
    try {
      setAudio(await readAudioFile(file));
    } catch (e) {
      toast('⚠️ Не удалось прочитать файл: ' + e.message, true);
    }
  }

  // Протухшая сессия не должна оставлять мёртвый интерфейс: любой 401 от API
  // возвращает на экран входа.
  const handleError = useCallback((e, fallback) => {
    if (String(e.message || '').includes('401')) { onUnauthorized(); return; }
    toast(fallback + ': ' + e.message, true);
  }, [onUnauthorized, toast]);

  // ── Автоскролл «липкий низ» ───────────────────────────────────────────────
  const onLogScroll = () => {
    const el = logRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const scrollDown = useCallback((force) => {
    if (force) stick.current = true;
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => { scrollDown(); });

  const patch = useCallback((id, upd) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...upd } : m)));
  }, []);

  // ── Заполненность контекста ───────────────────────────────────────────────
  // Токен последовательности, как у refresh: переключение чатов во время
  // подсчёта не должно показать цифру от предыдущего чата.
  const recount = useCallback(async (list) => {
    const seq = ++countSeq.current;
    const msgs = ctxMessages(list, settingsRef.current);
    if (!msgs.length) { setCtx({ used: 0, exact: true }); setCounting(false); return; }
    setCounting(true);
    const n = await llmApi.count(msgs, settingsRef.current);
    if (seq !== countSeq.current) return;
    setCounting(false);
    setCtx(n == null ? { used: estimateTokens(msgs), exact: false } : { used: n, exact: true });
  }, []);

  const reloadLimits = useCallback(async () => {
    // Сбой — сбрасываем: иначе в шапке остался бы паспорт прежней модели.
    const l = await llmApi.limits(settingsRef.current.model);
    setLimits(l);
  }, []);

  // Системный промпт, «помнить контекст», рассуждения и сама модель (у неё
  // свой токенайзер) меняют то, что уйдёт модели, — пересчитываем (с
  // задержкой, пока печатают промпт).
  useEffect(() => {
    if (streaming) return undefined;
    const t = setTimeout(() => recount(messagesRef.current), 500);
    return () => clearTimeout(t);
  }, [settings.system, settings.chatHistory, settings.thinking, settings.reasoningEffort, settings.model, recount]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Список чатов ──────────────────────────────────────────────────────────
  const reloadChats = useCallback(async () => {
    try {
      setChats(await chatsApi.list());
    } catch (e) {
      handleError(e, 'Не удалось получить список чатов');
    }
  }, [handleError]);

  useEffect(() => { reloadChats(); }, [reloadChats]);

  async function selectChat(id) {
    if (streaming || id === currentChatId) return;
    try {
      const chat = await chatsApi.get(id);
      const list = chat.messages.map((m) => ({
        id: 'srv' + m.id, dbId: m.id, role: m.role, content: m.content, stats: m.stats || null,
        copyText: m.role === 'assistant' ? m.content : null,
      }));
      setCurrentChatId(id);
      setMessages(list);
      scrollDown(true);
      recount(list);
    } catch (e) {
      handleError(e, 'Не удалось открыть чат');
    }
  }

  function newChat() {
    if (streaming) return;
    // Чат заводится на сервере только с первой репликой — пустые в списке
    // не копятся.
    setCurrentChatId(null);
    setMessages([]);
    recount([]);
  }

  async function renameChat(id, title) {
    try {
      await chatsApi.rename(id, title);
      reloadChats();
    } catch (e) {
      handleError(e, 'Не удалось переименовать');
    }
  }

  async function deleteChat(chat) {
    if (!window.confirm(`Удалить чат «${chat.title}»? Переписка пропадёт безвозвратно.`)) return;
    try {
      await chatsApi.remove(chat.id);
      if (chat.id === currentChatId) { setCurrentChatId(null); setMessages([]); recount([]); }
      reloadChats();
      toast('Чат удалён');
    } catch (e) {
      handleError(e, 'Не удалось удалить');
    }
  }

  // ── Обнаружение модели / статус связи ─────────────────────────────────────
  // Токен последовательности: при быстрой правке в полёте несколько запросов,
  // и раньше побеждал пришедший последним, а не отправленный последним.
  const refresh = useCallback(async (manual) => {
    const seq = ++detectSeq.current;
    setStatus({ state: 'warn', text: 'проверка…' });
    const { models: list, servers: srv } = await listModels(!!manual);
    if (seq !== detectSeq.current) return;
    const ids = list.map((m) => m.id);
    const down = srv.filter((s) => !s.ok).map((s) => s.server);
    setServers(srv);

    if (!ids.length) {
      setStatus({ state: 'off', text: 'нет связи' });
      setModels([]);
      if (manual) toast('⚠️ Модели не найдены — проверьте бэкенд', true);
      return;
    }
    setModels(list);
    const cur = settings.model.trim();
    if (!ids.includes(cur)) {
      // Модель подняли на втором сервере — в списке она стала «имя #1» и
      // «имя #2»; сохранённое «имя» переводим на первый экземпляр. Обратно
      // не подменяем: выбранный «имя #2» при упавшем втором сервере остаётся
      // «недоступен», а не уезжает молча на первый.
      const numbered = / #\d+$/;
      const same = cur && !numbered.test(cur)
        && ids.find((id) => id.replace(numbered, '') === cur);
      // Без выбора — первая чат-модель: речевая годится только для записей.
      if (same) set({ model: same });
      else if (!cur || ids.length === 1) set({ model: (list.find((m) => m.kind !== 'asr') || list[0]).id });
    }
    // Часть серверов молчит — связь есть, но не со всеми.
    setStatus(down.length
      ? { state: 'warn', text: `нет связи с ${down.join(', ')}` }
      : { state: 'ok', text: 'подключено' });
    if (manual) {
      toast(down.length
        ? `⚠️ Моделей: ${ids.length} · нет связи с ${down.join(', ')}`
        : `✅ Связь есть · моделей: ${ids.length}`, down.length > 0);
    }
    reloadLimits();
  }, [settings.model, set, toast, reloadLimits]);

  // Лимит зависит от модели (у прокси с несколькими моделями он разный).
  useEffect(() => { reloadLimits(); }, [settings.model, reloadLimits]);

  useEffect(() => { refresh(false); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Отправка ──────────────────────────────────────────────────────────────
  async function onSend() {
    if (streaming) return;
    // Речевой модели уходит только запись: текст рядом с ней портит
    // распознавание, а поле ввода у неё и так выключено.
    const asr = isAsr;
    const text = asr ? '' : input.trim();
    const clip = canAttach ? audio : null;
    if (asr && !clip) { toast('⚠️ Приложите аудиозапись', true); return; }
    if (!text && !clip) return;
    if (!settings.model.trim()) { toast('⚠️ Выберите модель в настройках', true); return; }

    // В ленте и в истории запись остаётся строкой с именем файла: сами байты
    // не храним, а следующей модели хватит расшифровки.
    const shown = [text, clip && `🎙 ${clip.name}`].filter(Boolean).join('\n\n');
    const prior = messages;
    if (!asr) setInput('');
    setAudio(null);
    setStreaming(true);
    const userMsg = { id: uid(), role: 'user', content: shown };
    const base = [...prior, userMsg];
    setMessages(base);
    scrollDown(true);

    let chatId = currentChatId;
    try {
      // Чат и реплика пользователя сохраняются ДО запроса к модели: если она
      // не ответит, вопрос всё равно останется в истории.
      if (!chatId) {
        const chat = await chatsApi.create();
        chatId = chat.id;
        setCurrentChatId(chatId);
      }
      const saved = await chatsApi.addMessage(chatId, 'user', shown);
      userMsg.dbId = saved?.id;
      patch(userMsg.id, { dbId: saved?.id });
      reloadChats();
    } catch (e) {
      setStreaming(false);
      if (String(e.message || '').includes('401')) { onUnauthorized(); return; }
      setMessages([...base, { id: uid(), role: 'assistant', content: '', error: String(e.message || e) }]);
      return;
    }

    // Модели уходит сам текст, без строки «🎙 файл» — запись едет отдельно.
    await generate(chatId, base, { asr, clip, lastUserText: text });
  }

  // История для модели из ленты: ответы с ошибкой не уходят; без «помнить
  // контекст» — только последний вопрос.
  function historyOf(list, lastUserText) {
    const clean = list.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    if (lastUserText != null && clean.length) clean[clean.length - 1] = { role: 'user', content: lastUserText };
    return settingsRef.current.chatHistory ? clean : clean.slice(-1);
  }

  // Ответ модели на ленту base (последней в ней стоит вопрос пользователя):
  // общий путь для новой реплики, перегенерации и переотправки правленого
  // вопроса. Ответ сохраняется в чат chatId.
  async function generate(chatId, base, { asr = false, clip = null, lastUserText = null } = {}) {
    const settings = settingsRef.current;
    const id = uid();
    setStreaming(true);
    setMessages([...base, { id, role: 'assistant', content: '', transcript: asr }]);
    scrollDown(true);

    const history = historyOf(base, lastUserText);
    let stage = '';
    let full = '';
    let stats = null;
    let lastRender = 0;
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const events = asr
        ? streamAsr({ model: settings.model.trim(), audio: clip.dataUrl, signal: ac.signal })
        : streamChat({ history, settings, signal: ac.signal, audio: clip?.dataUrl });
      for await (const ev of events) {
        if (ev.type === 'stats') stats = ev.stats;
        else if (ev.type === 'stage') stage = ev.text;
        else if (ev.type === 'text') full = ev.text;     // расшифровка целиком: сервер мог откатить хвост
        else full += ev.text;
        const now = Date.now();
        if (now - lastRender >= RENDER_MS) { lastRender = now; patch(id, { content: full, stats, live: true, stage }); }
      }

      if (!full) {
        patch(id, { content: '(пустой ответ)', stats, live: false });
      } else {
        patch(id, { content: full, copyText: full, stats, live: false });
        // id в базе нужен, чтобы этот ответ потом можно было править и
        // перегенерировать.
        const saved = await chatsApi.addMessage(chatId, 'assistant', full, stats);
        patch(id, { dbId: saved?.id });
        reloadChats();
      }
      setStatus({ state: 'ok', text: 'подключено' });
      // usage — то, что бэкенд реально держит в контексте сессии после ответа.
      // У расшифровки это аудио и служебный промпт, а не переписка чата.
      if (!asr && stats?.prompt != null && stats.completion != null) {
        countSeq.current++;
        setCounting(false);
        setCtx({ used: stats.prompt + stats.completion, exact: true });
      } else {
        recount([...base, { role: 'assistant', content: full }]);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        // Прерванный ответ остаётся и в ленте, и в истории — иначе следующая
        // реплика уйдёт модели без предшествующего ответа.
        patch(id, { content: full, stopped: true, copyText: full || null, stats, live: false });
        if (full && chatId) {
          chatsApi.addMessage(chatId, 'assistant', full, stats)
            .then((saved) => { patch(id, { dbId: saved?.id }); reloadChats(); })
            .catch(() => {});
        }
        recount([...base, { role: 'assistant', content: full }]);
      } else if (String(e.message || '').includes('401')) {
        onUnauthorized();
      } else {
        console.error(e);
        patch(id, { content: full, error: String(e.message || e), copyText: full || null, stats, live: false });
        setStatus({ state: 'off', text: 'ошибка' });
        recount(base);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      reloadLimits();
    }
  }

  // ── Правка и перегенерация (как в AI Studio) ──────────────────────────────
  // Удалить из базы реплику index и всё после неё. У неудачных ответов id в
  // базе нет — режем с первой сохранённой.
  async function dropFrom(list, index) {
    const first = list.slice(index).find((m) => m.dbId);
    if (first && currentChatId) await chatsApi.truncateFrom(currentChatId, first.dbId);
  }

  async function regenerate(index) {
    if (streaming) return;
    if (isAsr) { toast('⚠️ Перегенерация — для чат-моделей; запись расшифровки не хранится', true); return; }
    const list = messagesRef.current;
    const base = list.slice(0, index);
    if (base[base.length - 1]?.role !== 'user') return;
    try {
      await dropFrom(list, index);
    } catch (e) {
      handleError(e, 'Не удалось убрать прежний ответ');
      return;
    }
    await generate(currentChatId, base);
    reloadChats();
  }

  async function editMessage(index, text, rerun) {
    if (streaming) return;
    const list = messagesRef.current;
    const m = list[index];
    if (!m) return;
    if (rerun && isAsr) { toast('⚠️ Выберите чат-модель, чтобы получить новый ответ', true); rerun = false; }
    try {
      if (m.dbId && currentChatId) await chatsApi.editMessage(currentChatId, m.dbId, text);
    } catch (e) {
      handleError(e, 'Не удалось сохранить правку');
      return;
    }
    const isAnswer = m.role === 'assistant';
    const updated = {
      ...m, content: text, copyText: isAnswer ? text : null, stats: null,
      edited: isAnswer, error: undefined, stopped: false,
    };
    if (rerun && m.role === 'user') {
      try {
        await dropFrom(list, index + 1);
      } catch (e) {
        handleError(e, 'Не удалось убрать прежний ответ');
        return;
      }
      await generate(currentChatId, [...list.slice(0, index), updated]);
      reloadChats();
    } else {
      const next = list.map((x, i) => (i === index ? updated : x));
      setMessages(next);
      recount(next);
    }
  }

  // Message обёрнут в memo: новые функции на каждый рендер перерисовывали бы
  // всю ленту на каждом токене. Стабильные обёртки зовут свежие версии.
  const actions = useRef(null);
  actions.current = { regenerate, editMessage };
  const onRegenerate = useCallback((i) => actions.current.regenerate(i), []);
  const onEdit = useCallback((i, text, rerun) => actions.current.editMessage(i, text, rerun), []);

  return (
    <div className="app">
      <Sidebar
        collapsed={collapsed}
        settings={settings}
        set={set}
        status={status}
        models={models}
        servers={servers}
        onRefresh={refresh}
        onCollapse={() => setCollapsed(true)}
        theme={theme}
        onTheme={onTheme}
        chats={chats}
        currentChatId={currentChatId}
        onSelectChat={selectChat}
        onNewChat={newChat}
        onRenameChat={renameChat}
        onDeleteChat={deleteChat}
        user={user}
        onLogout={onLogout}
      />
      {!collapsed && (
        <button className="sb-backdrop" aria-label="Закрыть панель" onClick={() => setCollapsed(true)} />
      )}

      <div className="main">
        <div className="topbar">
          {collapsed && (
            <button className="icon-btn" title="Показать панель" onClick={() => setCollapsed(false)} aria-label="Показать панель">
              <Menu />
            </button>
          )}
          <div className="tb-title">
            {chats.find((c) => c.id === currentChatId)?.title || 'Новый чат'}
          </div>
          <Link to="/local" className="tb-link" title="Очередь пакетной обработки файлов">🗂 Пакетная обработка</Link>
          <ModelBadge
            model={settings.model}
            label={settings.model ? modelLabel(models, settings.model) : '—'}
            limits={settings.model ? limits : null}
          />
        </div>

        <div className="log" ref={logRef} onScroll={onLogScroll}>
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="wi">💬</div>
              <div className="wt">WebUiLlm</div>
              <div className="wsub">
                {isAsr ? (
                  <>Приложите аудиозапись — модель распишет речь<br />с таймкодами и говорящими.</>
                ) : (
                  <>Напишите сообщение, чтобы начать диалог.<br />Переписка сохранится — прежние чаты слева.</>
                )}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <Message
                key={m.id}
                msg={m}
                index={i}
                busy={streaming}
                // Ответ на вопрос, а не расшифровка: запись после отправки не
                // хранится, повторить её нечем.
                canRegenerate={m.role === 'assistant' && messages[i - 1]?.role === 'user'
                  && !isAsr && !m.transcript && m.stats?.audio == null}
                onEdit={onEdit}
                onRegenerate={onRegenerate}
              />
            ))
          )}
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSend={onSend}
          onStop={() => abortRef.current?.abort()}
          streaming={streaming}
          canAttach={canAttach}
          audioOnly={isAsr}
          audio={audio}
          onAttach={attachAudio}
          onClearAudio={() => setAudio(null)}
          // Речевой модели история не уходит — и заполнять нечего.
          footer={isAsr ? null : <ContextMeter ctx={ctx} limits={limits} counting={counting} />}
        />
      </div>
    </div>
  );
}
