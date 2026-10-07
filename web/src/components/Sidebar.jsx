// Боковая панель: список чатов сверху, настройки диалога под ним (свёрнуты),
// внизу — кто вошёл и выход.
//
// Поля «Хост» и «API токен» убраны: адрес бэкенда задаётся на сервере
// (LM_BACKEND), а ключ к модели — LM_BACKEND_TOKEN. Класть ключ в браузер
// каждому пользователю незачем.

import { useEffect, useRef, useState } from 'react';

import { Chevron, ChevronLeft, LogOut, Logo, Moon, Plus, Refresh, Sun } from './Icons.jsx';
import { modelLabel } from '../lib/api.js';
import { effortsFor, supportedEffort } from '../lib/settings.js';

const Inline = ({ label, hint, children }) => (
  <div className="srow inline">
    <span className="slbl" title={hint}>{label}</span>
    {children}
  </div>
);

const Stacked = ({ label, hint, children }) => (
  <div className="srow">
    <span className="slbl" title={hint}>{label}</span>
    {children}
  </div>
);

function ChatItem({ chat, active, onSelect, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef(null);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function commit() {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== chat.title) onRename(chat.id, t);
    else setDraft(chat.title);
  }

  if (editing) {
    return (
      <div className="chat-item editing">
        <input
          ref={inputRef}
          className="chat-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setDraft(chat.title); setEditing(false); }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={'chat-item' + (active ? ' on' : '')}
      onClick={() => onSelect(chat.id)}
      onDoubleClick={() => { setDraft(chat.title); setEditing(true); }}
      title={chat.title + '\n(двойной щелчок — переименовать)'}
    >
      <span className="chat-title">{chat.title}</span>
      <button
        className="chat-del"
        title="Удалить чат"
        aria-label="Удалить чат"
        onClick={(e) => { e.stopPropagation(); onDelete(chat); }}
      >
        ×
      </button>
    </div>
  );
}

export default function Sidebar({
  collapsed, settings, set, status, models, servers, onRefresh, onCollapse, theme, onTheme,
  chats, currentChatId, onSelectChat, onNewChat, onRenameChat, onDeleteChat,
  user, onLogout,
}) {
  const [showSettings, setShowSettings] = useState(false);

  const num = (key, extra = {}) => (
    <input
      className="si sm"
      type="number"
      value={settings[key]}
      onChange={(e) => set({ [key]: e.target.value })}
      {...extra}
    />
  );
  const check = (key) => (
    <input type="checkbox" checked={!!settings[key]} onChange={(e) => set({ [key]: e.target.checked })} />
  );

  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')} aria-hidden={collapsed}>
      <div className="sb-hdr">
        <div className="sb-logo"><Logo /> WebUiLlm</div>
        <div className="sb-hdr-actions">
          <button
            className="icon-btn"
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            aria-label="Переключить тему"
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
          <button className="icon-btn" title="Свернуть панель" onClick={onCollapse} aria-label="Свернуть панель">
            <ChevronLeft />
          </button>
        </div>
      </div>

      <button className="new-chat" onClick={onNewChat}><Plus /> Новый чат</button>

      <div className="chat-list">
        {chats.length === 0
          ? <div className="chat-empty">Чатов пока нет</div>
          : chats.map((c) => (
            <ChatItem
              key={c.id}
              chat={c}
              active={c.id === currentChatId}
              onSelect={onSelectChat}
              onRename={onRenameChat}
              onDelete={onDeleteChat}
            />
          ))}
      </div>

      <div className="sb-settings">
        <button className="settings-toggle" onClick={() => setShowSettings((v) => !v)}>
          <Chevron open={showSettings} /> Настройки
          <span className="settings-model" title={settings.model}>
            {settings.model ? modelLabel(models, settings.model) : 'модель не выбрана'}
          </span>
        </button>

        {showSettings && (
          <div className="sb-body">
            <Stacked label="Модель">
              <div className="model-row">
                {/* Модели всех серверов одним списком, у каждой — порт её
                    сервера. Молчащие серверы — неактивными строками, чтобы
                    было видно, почему модели с них нет. Пока список не
                    получен, имя можно ввести руками. */}
                {models.length ? (
                  <select
                    className="si"
                    value={settings.model}
                    onChange={(e) => set({ model: e.target.value })}
                  >
                    {!models.some((m) => m.id === settings.model) && (
                      <option value={settings.model}>
                        {settings.model ? `${settings.model} (недоступна)` : 'выберите модель'}
                      </option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{modelLabel(models, m.id)}</option>
                    ))}
                    {(servers || []).filter((s) => !s.ok).map((s) => (
                      <option key={'down' + s.server} value={'down:' + s.server} disabled>
                        {s.server} — нет связи
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="si"
                    value={settings.model}
                    placeholder="выберите модель"
                    autoComplete="off"
                    spellCheck="false"
                    onChange={(e) => set({ model: e.target.value })}
                  />
                )}
                <button
                  className="icon-btn sm"
                  title="Обновить список моделей / проверить связь"
                  onClick={() => onRefresh(true)}
                  aria-label="Проверить связь"
                >
                  <Refresh />
                </button>
              </div>
            </Stacked>

            <div className="sb-label">Генерация</div>
            <Inline label="Температура" hint="0 — детерминированно, выше — разнообразнее.">
              {num('temp', { min: 0, max: 2, step: 0.1 })}
            </Inline>
            <Inline label="top_p" hint="Отсечение по накопленной вероятности. Пусто — решает бэкенд.">
              {num('topP', { placeholder: '—', min: 0, max: 1, step: 0.05 })}
            </Inline>
            <Inline label="Max tokens" hint="Потолок длины ответа. Пусто — решает бэкенд.">
              {num('maxTokens', { placeholder: 'авто', min: 1, step: 1 })}
            </Inline>
            <Inline label="Рассуждения модели" hint="Просить модель рассуждать перед ответом. Поддерживается не всеми моделями.">
              {check('thinking')}
            </Inline>
            <Inline
              label="Глубина рассуждений"
              hint="Насколько долго модель думает перед ответом (reasoning_effort). Уровни у моделей разные: GLM — низкая/высокая/максимальная, Step и прочие — низкая/средняя/высокая. Работает при включённых рассуждениях."
            >
              <select
                className="si sm effort"
                value={supportedEffort(settings.model, settings.reasoningEffort)}
                disabled={!settings.thinking}
                onChange={(e) => set({ reasoningEffort: e.target.value })}
              >
                {effortsFor(settings.model).map((e) => (
                  <option key={e.value} value={e.value}>{e.label}</option>
                ))}
              </select>
            </Inline>

            <div className="sb-label">Диалог</div>
            <Inline label="Помнить контекст" hint="Модель видит предыдущие реплики чата. Выключено — каждое сообщение уходит само по себе.">
              {check('chatHistory')}
            </Inline>
            <Stacked label="Системный промпт" hint="Инструкция, которая идёт перед диалогом. Пусто — не передаётся.">
              <textarea
                className="si sta"
                value={settings.system}
                placeholder="Например: отвечай кратко и по делу"
                onChange={(e) => set({ system: e.target.value })}
              />
            </Stacked>
          </div>
        )}
      </div>

      <div className="sb-bot">
        <div className="sr">
          <span className={'sd' + (status.state === 'ok' ? ' on' : status.state === 'warn' ? ' warn' : '')} />
          <span>{status.text}</span>
        </div>
        <div className="sb-user">
          <span className="sb-user-name" title={user?.username}>{user?.username}</span>
          <button className="icon-btn" onClick={onLogout} title="Выйти" aria-label="Выйти">
            <LogOut />
          </button>
        </div>
      </div>
    </aside>
  );
}
