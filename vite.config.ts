import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { darkTheme } from './src/build/dark-theme';
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [darkTheme()] } },
  build: { outDir: 'dist/client' },
  // The Mac app in desktop/ has its own dependencies and tests.
  test: { exclude: [...configDefaults.exclude, 'desktop/**'] },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
