// Заполненность контекста сессии: сколько токенов занимает переписка из того,
// что сервер даёт на одну сессию (слот). Ничего не ограничивает — только
// показывает, что диалог подходит к лимиту.

import { fmtNum } from '../lib/format.js';

const WARN = 0.75;
const DANGER = 0.9;

export default function ContextMeter({ ctx, limits, counting }) {
  const total = limits?.n_ctx || null;
  const used = ctx?.used ?? null;
  const approx = ctx && !ctx.exact ? '≈' : '';
  const frac = total && used != null ? Math.min(used / total, 1) : null;
  const level = frac == null ? '' : frac >= DANGER ? ' danger' : frac >= WARN ? ' warn' : '';

  const title = [
    total ? `Сервер даёт на сессию ${fmtNum(total)} токенов` : 'Сервер не сообщил размер контекста',
    limits?.n_ctx_train && limits.n_ctx_train !== total
      ? `модель обучена на ${fmtNum(limits.n_ctx_train)}` : null,
    limits?.slots ? `слотов (одновременных сессий): ${limits.slots}` : null,
    approx ? 'Занятое — оценка по длине текста: бэкенд не умеет считать токены' : null,
    level === ' danger' ? 'Почти упёрлись: модель начнёт терять начало диалога или вернёт ошибку — начните новый чат' : null,
  ].filter(Boolean).join('\n');

  return (
    <div className={'ctx-meter' + level} title={title}>
      <div className="ctx-bar" aria-hidden="true">
        <div className="ctx-fill" style={{ width: frac == null ? 0 : `${(frac * 100).toFixed(1)}%` }} />
      </div>
      <div className="ctx-text">
        <span>
          Контекст: <b>{used == null ? '—' : approx + fmtNum(used)}</b>
          {' / '}{total ? fmtNum(total) : '?'} ток.
          {frac != null ? ` · ${Math.round(frac * 100)}%` : ''}
          {total && used != null ? ` · свободно ${approx}${fmtNum(Math.max(total - used, 0))}` : ''}
          {counting ? <span className="ctx-dim"> · считаю…</span> : null}
        </span>
        {limits?.slots ? (
          <span className="ctx-dim">сервер: занято слотов {limits.busy ?? '?'} из {limits.slots}</span>
        ) : null}
      </div>
    </div>
  );
}
