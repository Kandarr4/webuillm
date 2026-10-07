// Одно сообщение ленты. memo — во время стрима меняется одно сообщение,
// остальные перерисовывать незачем.

import { memo, useState } from 'react';
import Markdown from './Markdown.jsx';
import { fmtNum } from '../lib/format.js';
import { useToast } from '../lib/toast.jsx';
import { copyText } from '../lib/clipboard.js';

// Копирует исходный текст ответа как есть — с разметкой Markdown,
// а не то, что из неё отрисовано.
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button
      className="mini-btn"
      title="Скопировать ответ как есть, с разметкой Markdown"
      onClick={async () => {
        try {
          await copyText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          // Молчать нельзя, иначе кнопка выглядит сломанной.
          toast('⚠️ Браузер не дал доступ к буферу обмена', true);
        }
      }}
    >
      {done ? '✓ Скопировано' : '⎘ Копировать'}
    </button>
  );
}

const fmtSec = (s) => (s >= 60
  ? `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с`
  : `${s.toFixed(1).replace('.', ',')} с`);

// Скорость и токены ответа. Во время генерации — живая скорость, после —
// полная сводка; подробности во всплывающей подсказке. У расшифровки ещё
// длина записи и RTF — во сколько раз распознавание быстрее самой записи.
function Stats({ st, live }) {
  const tps = st.tps ? st.tps.toFixed(1) : null;
  const title = [
    st.audio != null ? `Запись: ${fmtSec(st.audio)}` : null,
    st.infer != null ? `Распознавание: ${fmtSec(st.infer)}` : null,
    st.rtf != null ? `RTF ${st.rtf.toFixed(2)} — время распознавания / длина записи` : null,
    tps ? `Генерация: ${tps} ток/с` : null,
    st.pps ? `Обработка промпта: ${fmtNum(st.pps)} ток/с` : null,
    st.prompt != null
      ? `Запрос (вся переписка): ${fmtNum(st.prompt)} ток.` + (st.cached ? `, из кэша ${fmtNum(st.cached)}` : '')
      : null,
    st.completion != null ? `Ответ: ${fmtNum(st.completion)} ток.` : null,
  ].filter(Boolean).join('\n');

  return (
    <span className={'msg-stats' + (live ? ' live' : '')} title={title}>
      <b className="msg-speed">⚡ {tps ?? '…'} ток/с</b>
      {st.completion != null ? <span> · ↓{fmtNum(st.completion)}</span> : null}
      {!live && st.prompt != null ? <span> · ↑{fmtNum(st.prompt)}</span> : null}
      {!live && st.pps ? <span> · промпт {fmtNum(st.pps)} ток/с</span> : null}
      {st.audio != null ? <span> · 🎙 {fmtSec(st.audio)}</span> : null}
      {!live && st.rtf != null ? <span> · RTF {st.rtf.toFixed(2)}</span> : null}
    </span>
  );
}

// Правка реплики прямо в пузыре, как в AI Studio. У вопроса — ещё «Сохранить
// и отправить»: переписка после него отбрасывается, и модель отвечает заново.
// Ctrl+Enter — главное действие, Esc — отмена.
function Editor({ initial, isUser, onSave, onCancel }) {
  const [text, setText] = useState(initial);
  const changed = text.trim() !== '' && text !== initial;
  const main = (rerun) => { if (text.trim()) onSave(text, rerun); };
  return (
    <div className="msg-edit">
      <textarea
        className="si msg-edit-ta"
        value={text}
        autoFocus
        rows={Math.min(Math.max(text.split('\n').length, 3), 18)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); main(isUser); }
        }}
      />
      <div className="copy-row">
        {isUser ? (
          <button className="mini-btn on" disabled={!text.trim()} onClick={() => main(true)}
            title="Сохранить вопрос, убрать всё после него и получить новый ответ (Ctrl+Enter)">
            ➤ Сохранить и отправить
          </button>
        ) : null}
        <button className={'mini-btn' + (isUser ? '' : ' on')} disabled={!changed} onClick={() => main(false)}
          title={isUser ? 'Только исправить текст вопроса, ответ не трогать' : 'Сохранить правку ответа (Ctrl+Enter)'}>
          ✓ Сохранить
        </button>
        <button className="mini-btn" onClick={onCancel} title="Esc">Отмена</button>
      </div>
    </div>
  );
}

function Message({ msg, index, busy, canRegenerate, onEdit, onRegenerate }) {
  const [editing, setEditing] = useState(false);
  const save = (text, rerun) => { setEditing(false); onEdit(index, text, rerun); };

  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="av">🧑</div>
        <div className="mb">
          {editing ? (
            <Editor initial={msg.content} isUser onSave={save} onCancel={() => setEditing(false)} />
          ) : (
            <>
              <div className="bbl">{msg.content}</div>
              <div className="copy-row msg-actions">
                <button className="mini-btn" disabled={busy} onClick={() => setEditing(true)}
                  title="Изменить вопрос">✎ Изменить</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const failed = !!msg.error;
  const st = msg.stats;
  // Расшифровка — строки «[00:01.2 - 00:04.8] [Speaker 1, …]: …» и «[note]:».
  // Markdown склеил бы строки в абзац, а «[note]:» принял бы за ссылку, —
  // показываем как есть. У сохранённой её узнаём по длине записи в stats.
  const transcript = msg.transcript || st?.audio != null;
  const done = !msg.live;
  return (
    <div className={'msg assistant' + (failed ? ' err' : '')}>
      <div className="av">{failed ? '⚠️' : (transcript ? '🎙' : '🤖')}</div>
      <div className="mb">
        {editing ? (
          <Editor initial={msg.content} onSave={save} onCancel={() => setEditing(false)} />
        ) : (
          <div className={'bbl ' + (transcript ? 'transcript' : 'md-bbl')}>
            {msg.live && msg.stage ? <div className="transcript-stage">{msg.stage}</div> : null}
            {msg.content ? (transcript ? msg.content : <Markdown text={msg.content} />) : null}
            {msg.stopped ? <div className="msg-note">— остановлено</div> : null}
            {msg.edited ? <div className="msg-note">— изменено вручную</div> : null}
            {failed ? <div className="msg-note err">⚠️ Ошибка: {msg.error}</div> : null}
            {!msg.content && !msg.stopped && !failed ? <span className="cursor">▍</span> : null}
          </div>
        )}
        {!editing && (msg.copyText || st || done) ? (
          <div className="copy-row msg-actions">
            {msg.copyText ? <CopyBtn text={msg.copyText} /> : null}
            {done && canRegenerate ? (
              <button className="mini-btn" disabled={busy} onClick={() => onRegenerate(index)}
                title="Получить новый ответ на тот же вопрос; этот и всё после него будет удалено">
                ⟳ Перегенерировать
              </button>
            ) : null}
            {done && msg.content && !transcript ? (
              <button className="mini-btn" disabled={busy} onClick={() => setEditing(true)}
                title="Исправить ответ — модель увидит правленый текст в следующих репликах">
                ✎ Изменить
              </button>
            ) : null}
            {st ? <Stats st={st} live={!!msg.live} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default memo(Message);
