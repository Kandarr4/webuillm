// Состояние входа. Проверяем сессию один раз при загрузке: кука httponly,
// из JavaScript её не прочитать, поэтому спрашиваем сервер.

import { useCallback, useEffect, useState } from 'react';
import { authApi } from './api.js';

export function useAuth() {
  const [state, setState] = useState({ loading: true, user: null, allowRegistration: true });

  useEffect(() => {
    let alive = true;
    authApi.me()
      .then((r) => alive && setState({ loading: false, user: r.user, allowRegistration: r.allowRegistration }))
      .catch(() => alive && setState({ loading: false, user: null, allowRegistration: true }));
    return () => { alive = false; };
  }, []);

  const enter = useCallback(async (mode, username, password) => {
    const r = mode === 'register'
      ? await authApi.register(username, password)
      : await authApi.login(username, password);
    setState((s) => ({ ...s, loading: false, user: r.user }));
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch { /* всё равно выходим на клиенте */ }
    setState((s) => ({ ...s, user: null }));
  }, []);

  // Сессия могла протухнуть, пока страница была открыта: любой 401 от API
  // возвращает нас на экран входа, а не оставляет мёртвый интерфейс.
  const dropSession = useCallback(() => setState((s) => ({ ...s, user: null })), []);

  return { ...state, enter, logout, dropSession };
}
