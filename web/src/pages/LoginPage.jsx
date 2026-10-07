// Экран входа. Пока пользователь не вошёл, ничего другого интерфейс не
// показывает — и бэкенд модели тоже закрыт (см. login_required в server.py).

import { useState } from 'react';

import { Logo, Moon, Sun } from '../components/Icons.jsx';

export default function LoginPage({ onEnter, allowRegistration, theme, onTheme }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isRegister = mode === 'register';

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await onEnter(mode, username.trim(), password);
    } catch (err) {
      setError(err.message || 'Не получилось');
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <button
        className="icon-btn auth-theme"
        onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
        title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        aria-label="Переключить тему"
      >
        {theme === 'dark' ? <Sun /> : <Moon />}
      </button>

      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo"><Logo size={22} /> WebUiLlm</div>
        <div className="auth-sub">
          {isRegister ? 'Создайте учётную запись' : 'Войдите, чтобы продолжить'}
        </div>

        <label className="auth-field">
          <span>Имя пользователя</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            spellCheck="false"
          />
        </label>

        <label className="auth-field">
          <span>Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
        </label>

        {isRegister && (
          <div className="auth-hint">
            Имя: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание.
            Пароль — от 8 символов.
          </div>
        )}

        {error && <div className="auth-error">{error}</div>}

        <button className="auth-submit" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? 'Минуту…' : isRegister ? 'Зарегистрироваться' : 'Войти'}
        </button>

        {allowRegistration ? (
          <button
            type="button"
            className="auth-switch"
            onClick={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }}
          >
            {isRegister ? 'У меня уже есть учётная запись' : 'Зарегистрироваться'}
          </button>
        ) : (
          !isRegister && <div className="auth-hint">Регистрация закрыта администратором.</div>
        )}
      </form>
    </div>
  );
}
