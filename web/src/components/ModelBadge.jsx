// Паспорт выбранной модели в шапке чата: имя и коротко — сколько параметров,
// какой квант, сколько весит. Подробности — во всплывающей подсказке.
//
// Данные приходят вместе с лимитами контекста (/api/llm/limits → info): что
// сообщил бэкенд (llama.cpp знает почти всё, vLLM — почти ничего), а чего нет —
// прочитано сервером из имени файла или модели.

import { fmtBytes, fmtNum, fmtParams } from '../lib/format.js';

export default function ModelBadge({ label, model, limits }) {
  const info = limits?.info || null;

  const params = fmtParams(info?.n_params);
  const active = fmtParams(info?.n_params_active);
  const size = fmtBytes(info?.size);
  const quant = info?.quant || info?.ftype || null;

  const chips = [
    params ? (active ? `${params} (акт. ${active})` : params) : null,
    quant,
    size,
  ].filter(Boolean);

  const title = [
    model || null,
    params ? `Параметров: ${fmtNum(info.n_params)}${info.params_from_name ? ' (по имени модели)' : ''}` : null,
    active ? `Активных на токен (MoE): ${active}` : null,
    quant ? `Квантизация: ${quant}${info.ftype && info.ftype !== quant ? ` — ${info.ftype}` : ''}` : null,
    size ? `Размер весов: ${size}` : null,
    limits?.n_ctx ? `Контекст на сессию: ${fmtNum(limits.n_ctx)} ток.` : null,
    limits?.n_ctx_train ? `Модель обучена на контексте: ${fmtNum(limits.n_ctx_train)} ток.` : null,
    info?.n_vocab ? `Словарь: ${fmtNum(info.n_vocab)} токенов` : null,
    info?.runtime ? `Движок: ${info.runtime}` : null,
    info?.file ? `Файл: ${info.file}` : null,
  ].filter(Boolean).join('\n');

  return (
    <div className="tb-model" title={title}>
      <span className="tb-model-name">{label}</span>
      {chips.map((c) => <span key={c} className="tb-chip">{c}</span>)}
    </div>
  );
}
