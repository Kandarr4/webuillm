// Иконки — inline-SVG, currentColor. Отдельным файлом, чтобы разметка
// компонентов не тонула в путях.

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const Logo = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="url(#wl-grad)" strokeWidth="2" aria-hidden="true">
    <defs>
      <linearGradient id="wl-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#8b7cf6" />
        <stop offset="100%" stopColor="#c084fc" />
      </linearGradient>
    </defs>
    <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" />
  </svg>
);

export const ChevronLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...S}><polyline points="15 18 9 12 15 6" /></svg>
);

export const Menu = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...S}>
    <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

export const Refresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...S}>
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

export const Trash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...S}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const Clip = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...S}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

export const Send = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

export const Stop = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
);

export const Sun = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...S}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2M12 19.4v2M4.6 12h-2M21.4 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
  </svg>
);

export const Moon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...S}>
    <path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8z" />
  </svg>
);

export const Plus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...S}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
);

export const LogOut = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...S}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

export const Chevron = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" {...S}
    style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

export const Paperclip = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" {...S}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);
