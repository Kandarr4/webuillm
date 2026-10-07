// Копирование в буфер обмена. navigator.clipboard есть только в защищённом
// контексте (https или localhost) — сервер же обычно открывают по http и IP
// из локальной сети. Тогда — старый способ через скрытую textarea и
// execCommand('copy'): он устарел, но работает и без https.

export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Нет разрешения — пробуем запасной способ.
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  // Выделение пользователя сбросится — вернём его после копирования.
  const sel = document.getSelection();
  const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
    if (sel) {
      sel.removeAllRanges();
      ranges.forEach((r) => sel.addRange(r));
    }
  }
  if (!ok) throw new Error('copy failed');
}
