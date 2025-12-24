import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import UnoCSS from '@unocss/vite';

export default defineConfig({
  plugins: [
    UnoCSS(),
    solid(),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    transformMode: {
      web: [/\.[jt]sx?$/],
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'src-tauri/',
        '**/*.config.*',
        '**/mockTauri.ts',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
    },
    setupFiles: ['./src/__tests__/setup.ts'],
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
