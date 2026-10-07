// ════════════════════════════════════════════════════════════════════════════
// Настройки панели: дефолты, хранение в localStorage, миграция со старых
// сохранений.
//
// Источник истины один — DEFAULTS: что в нём есть, то и сохраняется. Раньше
// список вёлся двумя массивами руками, и часть полей в него просто не попала —
// они сбрасывались при перезагрузке страницы.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';

const KEY = 'webuillm_settings';
const LEGACY_KEYS = ['g4asr_settings'];

export const DEFAULTS = {
  model: '',

  // Генерация
  temp: '0.7',
  topP: '',
  maxTokens: '',
  thinking: false,
  // Глубина рассуждений: '' — как решит модель, иначе low / high / max.
  reasoningEffort: '',

  // Диалог
  system: '',
  chatHistory: true,
};

// Имена полей в прежних версиях → текущие.
const LEGACY_MAP = {
  modelInput: 'model',
  tempInput: 'temp',
  systemPrompt: 'system',
  asrThinking: 'thinking',
};

function readLegacy() {
  for (const key of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const old = JSON.parse(raw);
      if (!old || typeof old !== 'object') continue;
      const out = {};
      for (const [k, v] of Object.entries(old)) {
        const name = LEGACY_MAP[k] || k;
        if (name in DEFAULTS) out[name] = v;
      }
      return out;
    } catch { /* следующий ключ */ }
  }
  return null;
}

export function loadSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    stored = null;
  }
  if (!stored) stored = readLegacy();
  if (!stored || typeof stored !== 'object') return { ...DEFAULTS };

  // Только известные ключи — мусор из старых версий не тащим. Тип приводим к
  // типу дефолта: в прежних сохранениях числовые поля могли оказаться числами,
  // а панель зовёт у них .trim() и падала бы на первом же рендере.
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = stored[k];
    if (v == null) continue;
    out[k] = typeof DEFAULTS[k] === 'boolean' ? !!v : String(v);
  }
  return out;
}

export function useSettings() {
  const [settings, setSettings] = useState(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* приватный режим / переполненное хранилище — не критично */
    }
  }, [settings]);

  const set = useCallback((patch) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  return [settings, set];
}

// Параметры генерации для запроса. Пустые поля опускаются — тогда действуют
// значения самого бэкенда.
export function genParams(s) {
  const num = (v) => {
    const t = String(v ?? '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const p = {};
  const temp = num(s.temp);
  p.temperature = temp == null ? 0.7 : temp;
  const topP = num(s.topP);
  if (topP != null) p.top_p = topP;
  const maxTokens = num(s.maxTokens);
  if (maxTokens != null) p.max_tokens = maxTokens;

  // Рассуждения модели. Шлём и top-level флагом, и в OpenAI-стиле
  // chat_template_kwargs — бэкенд понимает оба.
  p.enable_thinking = !!s.thinking;
  p.chat_template_kwargs = { enable_thinking: !!s.thinking };

  // Глубина — только при включённых рассуждениях и только если выбрана: тогда
  // модель без поддержки reasoning_effort получает тот же запрос, что раньше.
  // Шаблоны (GLM-5.3) читают её из chat_template_kwargs, OpenAI-совместимые
  // бэкенды — из top-level поля.
  // Уровень, которого у выбранной модели нет, не шлём: шаблон подставил бы
  // его как есть, а модель такого слова не знает.
  const effort = supportedEffort(s.model, s.reasoningEffort);
  if (s.thinking && effort) {
    p.reasoning_effort = effort;
    p.chat_template_kwargs.reasoning_effort = effort;
  }
  return p;
}

// Глубина рассуждений. Набор уровней у моделей разный — каждая знает только
// те слова, на которых её учили: GLM-5.x — low/high/max (по умолчанию max),
// Step-3.x и OpenAI-совместимые — low/medium/high.
const EFFORT_LABELS = { low: 'низкая', medium: 'средняя', high: 'высокая', max: 'максимальная' };
const EFFORTS_BY_MODEL = [
  { match: /glm/i, levels: ['low', 'high', 'max'], fallback: 'max' },
  { match: /step/i, levels: ['low', 'medium', 'high'], fallback: null },
];
const EFFORTS_DEFAULT = { levels: ['low', 'medium', 'high'], fallback: null };

function effortProfile(model) {
  return EFFORTS_BY_MODEL.find((p) => p.match.test(model || '')) || EFFORTS_DEFAULT;
}

// Варианты для панели настроек: [{ value, label }], первый — «по умолчанию».
export function effortsFor(model) {
  const p = effortProfile(model);
  const def = p.fallback ? `по умолчанию (${EFFORT_LABELS[p.fallback]})` : 'по умолчанию';
  return [{ value: '', label: def }, ...p.levels.map((v) => ({ value: v, label: EFFORT_LABELS[v] }))];
}

// Сохранённый уровень, если выбранная модель его знает; иначе '' (решает модель).
export function supportedEffort(model, effort) {
  return effort && effortProfile(model).levels.includes(effort) ? effort : '';
}

// ── Тема ────────────────────────────────────────────────────────────────────
const THEME_KEY = 'webuillm_theme';

export function useTheme() {
  const [theme, setThemeState] = useState(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === 'dark' || t === 'light') return t;
    } catch { /* приватный режим */ }
    return 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch { /* приватный режим */ }
  }, [theme]);

  return [theme, setThemeState];
}
