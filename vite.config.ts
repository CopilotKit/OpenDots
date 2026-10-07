import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme';
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [darkTheme()] } },
  build: { outDir: 'dist/client' },
  server: {
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
