// Мелкие чистые утилиты.

let _seq = 0;
export const uid = () => `m${Date.now().toString(36)}${(_seq++).toString(36)}`;

// 65536 → «65 536» (узкий неразрывный пробел, как принято в русской записи).
export const fmtNum = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU') : '—');

// Число с не более чем одним знаком после запятой: 320.76 → «320,8», 26 → «26».
const fmt1 = (x) => x.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

// 320759404382 → «320,8 млрд», 4e9 → «4 млрд», 8e8 → «800 млн».
export const fmtParams = (n) => {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e12) return fmt1(n / 1e12) + ' трлн';
  if (n >= 1e9) return fmt1(n / 1e9) + ' млрд';
  return fmt1(n / 1e6) + ' млн';
};

// 240296566136 → «240 ГБ» (десятичные, как пишут размеры моделей).
export const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e12) return fmt1(n / 1e12) + ' ТБ';
  if (n >= 1e9) return fmt1(n / 1e9) + ' ГБ';
  return fmt1(n / 1e6) + ' МБ';
};
