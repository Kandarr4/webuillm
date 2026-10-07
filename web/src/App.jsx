// Пока пользователь не вошёл, интерфейс не показывает ничего, кроме формы
// входа: бэкенд модели закрыт на сервере, и притворяться рабочим ни к чему.

import { Route, Routes } from 'react-router-dom';

import ChatPage from './pages/ChatPage.jsx';
import LocalPage from './pages/LocalPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import { useTheme } from './lib/settings.js';
import { useAuth } from './lib/useAuth.js';

export default function App() {
  const [theme, setTheme] = useTheme();
  const { loading, user, allowRegistration, enter, logout, dropSession } = useAuth();

  if (loading) return <div className="boot">Загрузка…</div>;

  if (!user) {
    return (
      <LoginPage
        onEnter={enter}
        allowRegistration={allowRegistration}
        theme={theme}
        onTheme={setTheme}
      />
    );
  }

  const common = { theme, onTheme: setTheme, user, onLogout: logout, onUnauthorized: dropSession };
  return (
    <Routes>
      <Route path="/" element={<ChatPage {...common} />} />
      <Route path="/local" element={<LocalPage {...common} />} />
      <Route path="*" element={<ChatPage {...common} />} />
    </Routes>
  );
}
