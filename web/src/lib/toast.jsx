// Тосты. В старом фронте каждый вызов вешал свой div с одинаковым
// position:fixed — два подряд ложились друг на друга и читался только верхний.
// Здесь один контейнер и стопка.

import { createContext, useCallback, useContext, useRef, useState } from 'react';

const Ctx = createContext(() => {});
export const useToast = () => useContext(Ctx);

const LIFETIME = 2400;

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);

  const toast = useCallback((text, isErr = false) => {
    const id = ++seq.current;
    setItems((list) => [...list, { id, text, isErr }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), LIFETIME);
  }, []);

  return (
    <Ctx.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={'toast' + (t.isErr ? ' err' : '')}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
