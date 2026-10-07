// ════════════════════════════════════════════════════════════════════════════
// Локальная обработка — мониторинг очереди батч-транскрипции.
// Сервер держит состояние сам (local_processing.py), страница его опрашивает.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Logo, Moon, Sun } from '../components/Icons.jsx';
import { localApi } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';

const STATUS_LABELS = {
  completed: 'Готово', silent: 'Без звука', error: 'Ошибка',
  pending: 'В очереди', processing: 'В обработке',
};
const STAGE_LABELS = {
  analyzing: 'Анализ громкости', transcribing: 'Распознавание на сервере',
};

const POLL_MS = 2000;

export default function LocalPage({ theme, onTheme }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState({ input_dir: '', model: '', prompt: '' });
  const cfgDirty = useRef(false);   // не затирать поля во время редактирования
  const inFlight = useRef(false);   // опрос не должен наслаиваться сам на себя
  const toast = useToast();

  // Страница длинная — в отличие от чата ей нужен обычный скролл документа.
  useEffect(() => {
    document.body.classList.add('page-scroll');
    return () => document.body.classList.remove('page-scroll');
  }, []);

  const apply = useCallback((s) => {
    setSt(s);
    if (!cfgDirty.current && s.config) {
      setCfg({
        input_dir: s.config.input_dir || '',
        model: s.config.model || '',
        prompt: s.config.prompt || '',
      });
    }
  }, []);

  // Опрос: пропускаем, пока предыдущий ответ не пришёл, и молчим на скрытой
  // вкладке — иначе фоновая страница часами дёргает сервер впустую.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || inFlight.current || document.hidden) return;
      inFlight.current = true;
      try {
        apply(await localApi.status());
      } catch { /* сеть моргнула — следующий тик разберётся */ }
      finally { inFlight.current = false; }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop = true; clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [apply]);

  async function action(fn, okMsg) {
    setBusy(true);
    try {
      const data = await fn();
      if (data.status) apply(data.status);
      if (okMsg) toast(okMsg(data));
    } catch (e) {
      toast('Ошибка: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  const running = !!st?.running;
  const t = st?.totals || {};
  const done = (t.completed || 0) + (t.silent || 0) + (t.error || 0);
  const total = t.total || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const field = (key, label, placeholder, wide) => (
    <label className={'lp-field' + (wide ? ' lp-field-wide' : '')}>
      <span>{label}</span>
      <input
        className="lp-input"
        spellCheck="false"
        placeholder={placeholder}
        value={cfg[key]}
        onChange={(e) => { cfgDirty.current = true; setCfg((c) => ({ ...c, [key]: e.target.value })); }}
      />
    </label>
  );

  return (
    <div className="lp-wrap">
      <div className="lp-topbar">
        <div className="lp-logo"><Logo /> Локальная обработка</div>
        <div className="lp-topbar-right">
          <span className={'lp-run' + (running ? ' on' : '')}>
            <span className="lp-dot" />
            <span>{running ? 'Идёт обработка' : 'Остановлено'}</span>
          </span>
          <button
            className="icon-btn"
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            aria-label="Переключить тему"
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
          <Link className="lp-link" to="/">← К транскрипции</Link>
        </div>
      </div>

      <div className="lp-body">
        <section className="lp-card">
          <div className="lp-card-title">Настройки очереди</div>
          <div className="lp-config">
            {field('input_dir', 'Папка с аудио (на сервере)', '…/static/audio_package')}
            {field('model', 'Модель (пусто → авто)', 'автоопределение')}
            {field('prompt', 'Инструкция (пусто → серверный промпт)', 'напр. Точная транскрипция с таймкодами', true)}
            <button
              className="lp-btn ghost"
              disabled={busy}
              onClick={() => action(
                async () => {
                  const r = await localApi.config(cfg);
                  cfgDirty.current = false;
                  return r;
                },
                (d) => `Сохранено. Найдено новых файлов: ${d.added ?? 0}`,
              )}
            >
              Сохранить и пересканировать
            </button>
          </div>
          {st && !st.ffmpeg && (
            <div className="lp-note">
              ⚠️ ffmpeg не найден (ffmpeg/bin) — проверка на тишину отключена, все файлы уйдут на распознавание.
            </div>
          )}
        </section>

        <section className="lp-controls">
          <div className="lp-controls-left">
            <span className="lp-threshold">
              Порог тишины: {st?.silence_threshold_db ?? '—'} dB
            </span>
          </div>
          <div className="lp-controls-actions">
            <button className="lp-btn primary" disabled={busy || running} onClick={() => action(localApi.start)}>▶ Старт</button>
            <button className="lp-btn" disabled={busy || !running} onClick={() => action(localApi.stop)}>■ Стоп</button>
            <button
              className="lp-btn"
              disabled={busy}
              onClick={() => action(localApi.rescan, (d) => `Добавлено новых файлов: ${d.added ?? 0}`)}
            >
              ⟳ Пересканировать
            </button>
          </div>
        </section>

        <section className="lp-stats">
          <div className="lp-stat"><span className="lp-v">{t.total || 0}</span><span className="lp-l">Всего</span></div>
          <div className="lp-stat done"><span className="lp-v">{t.completed || 0}</span><span className="lp-l">Транскрибировано</span></div>
          <div className="lp-stat silent"><span className="lp-v">{t.silent || 0}</span><span className="lp-l">Без звука</span></div>
          <div className="lp-stat error"><span className="lp-v">{t.error || 0}</span><span className="lp-l">Ошибки</span></div>
          <div className="lp-stat active"><span className="lp-v">{t.processing || 0}</span><span className="lp-l">В обработке</span></div>
          <div className="lp-stat"><span className="lp-v">{t.pending || 0}</span><span className="lp-l">В очереди</span></div>
        </section>

        <section className="lp-progress-wrap">
          <div className="lp-bar"><div className="lp-fill" style={{ width: pct + '%' }} /></div>
          <div className="lp-progress-text">{done} из {total} обработано ({pct}%)</div>
        </section>

        {st?.current && (
          <section className="lp-current">
            <div className="lp-spinner" />
            <div className="lp-current-info">
              <span className="lp-current-label">Сейчас обрабатывается</span>
              <span className="lp-current-name">{st.current.name}</span>
              <span className="lp-current-stage">{STAGE_LABELS[st.current.stage] || st.current.stage || ''}</span>
            </div>
          </section>
        )}

        <section className="lp-section">
          <div className="lp-section-title">Пакеты</div>
          <div className="lp-folders">
            {!st?.packages?.length ? (
              <p className="lp-empty">Пакеты не найдены. Проверьте папку и нажмите «Пересканировать».</p>
            ) : st.packages.map((p) => {
              const pdone = p.done || 0;
              const ppct = p.total > 0 ? Math.round((pdone / p.total) * 100) : 0;
              return (
                <div className="lp-folder" key={p.name}>
                  <div className="lp-folder-head">
                    <span className="lp-folder-name">{p.name}</span>
                    <div className="lp-badges">
                      <span className="lp-mini b-done">{p.completed} готово</span>
                      <span className="lp-mini b-silent">{p.silent} без звука</span>
                      {p.error ? <span className="lp-mini b-error">{p.error} ошибок</span> : null}
                      {p.pending ? <span className="lp-mini">{p.pending} в очереди</span> : null}
                    </div>
                    {p.xlsx
                      ? <a className="lp-btn ghost lp-xlsx" href={localApi.xlsxUrl(p.name)}>⤓ XLSX</a>
                      : <span className="lp-empty">XLSX ещё нет</span>}
                  </div>
                  <div className="lp-bar"><div className="lp-fill" style={{ width: ppct + '%' }} /></div>
                  <div className="lp-folder-count">{pdone} / {p.total}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-section-title">Последние события</div>
          <div className="lp-recent">
            {!st?.recent?.length ? (
              <p className="lp-empty">Событий пока нет.</p>
            ) : st.recent.map((ev, i) => (
              <div className="lp-recent-item" key={`${ev.name}-${ev.ts}-${i}`}>
                <span className={'lp-tag ' + ev.status}>{STATUS_LABELS[ev.status] || ev.status}</span>
                <span className="lp-recent-name" title={ev.name}>{ev.name}</span>
                <span className="lp-recent-msg">{ev.message || ''}</span>
                <span className="lp-recent-ts">{(ev.ts || '').replace('T', ' ')}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
