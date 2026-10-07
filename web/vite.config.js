import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Сборка кладётся в ../static/dist и отдаётся Flask'ом как статика.
// base фиксирован: Flask раздаёт ассеты по /static/dist/*.
//
// Dev-режим (npm run dev) проксирует API на Flask :5900 — фронт при этом
// живёт на :5173 с горячей перезагрузкой. Страница /local — маршрут React,
// а её API переехало под /api/local/* именно чтобы не конфликтовать с ним.
export default defineConfig({
  plugins: [react()],
  base: '/static/dist/',
  build: {
    outDir: '../static/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://localhost:5900',
      '/api': 'http://localhost:5900',
      '/tests': 'http://localhost:5900',
    },
  },
});
