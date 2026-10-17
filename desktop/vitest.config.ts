import { defineConfig } from 'vitest/config';

// Keeps the repository root's web-app config out of the Mac app's tests.
export default defineConfig({ test: { environment: 'node' } });
