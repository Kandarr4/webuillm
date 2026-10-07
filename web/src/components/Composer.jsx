// Композер: автотянущийся textarea, отправка/стоп, приложенная аудиозапись.
//
// Скрепка есть, только если выбранная модель принимает звук. Речевой модели
// (audioOnly) текст не нужен: её учили на одной записи без слов рядом, —
// поле ввода гаснет, отправляется только запись.

import { useEffect, useRef } from 'react';
import { Paperclip, Send, Stop } from './Icons.jsx';
import { AUDIO_ACCEPT } from '../lib/api.js';

const fmtSize = (n) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ');

export default function Composer({
  value, onChange, onSend, onStop, streaming, footer,
  canAttach, audioOnly, audio, onAttach, onClearAudio,
}) {
  const taRef = useRef(null);
  const fileRef = useRef(null);

  // Автовысота: сбрасываем, затем тянем по содержимому до потолка.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [value]);

  const placeholder = audioOnly
    ? (audio ? 'Запись готова — отправьте её на распознавание' : 'Модель распознаёт речь: приложите аудиозапись 📎')
    : 'Сообщение модели…   (Enter — отправить, Shift+Enter — перенос строки)';

  return (
    <div className="composer">
      {audio ? (
        <div className="attach-row">
          <span className="attach-chip" title={audio.name}>
            🎙 <span className="attach-name">{audio.name}</span>
            <span className="attach-size">{fmtSize(audio.size)}</span>
            {!streaming && (
              <button className="attach-x" onClick={onClearAudio} title="Убрать запись" aria-label="Убрать запись">×</button>
            )}
          </span>
        </div>
      ) : null}
      <div className="composer-row">
        {canAttach && (
          <>
            <button
              className="icon-btn attach-btn"
              onClick={() => fileRef.current?.click()}
              disabled={streaming}
              title="Приложить аудиозапись"
              aria-label="Приложить аудиозапись"
            >
              <Paperclip />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={AUDIO_ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';            // тот же файл второй раз — тоже событие
                if (f) onAttach(f);
              }}
            />
          </>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={audioOnly ? '' : value}
          disabled={audioOnly}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        {streaming ? (
          <button className="send-btn stop" onClick={onStop} title="Остановить"><Stop /></button>
        ) : (
          <button
            className="send-btn"
            onClick={onSend}
            disabled={audioOnly && !audio}
            title={audioOnly ? 'Распознать запись' : 'Отправить (Enter)'}
          >
            <Send />
          </button>
        )}
      </div>
      {footer}
    </div>
  );
}
