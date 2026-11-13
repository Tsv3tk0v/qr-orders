import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Разработка: отворете напр. http://hasan.lvh.me:5173 (lvh.me сочи към 127.0.0.1 с всички поддомейни).
// Заявките към /api отиват към сървъра със същия Host, за да се разпознае бизнесът.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
