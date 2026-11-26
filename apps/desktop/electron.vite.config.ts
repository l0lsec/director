import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Workspace packages ship TypeScript source, so they must be bundled, not externalized.
const workspace = ['@director/agent', '@director/engine', '@director/media', '@director/analysis', '@director/ai', '@director/library'];
// Release builds bundle every dependency, so the packaged app needs no node_modules at all.
const externalize = process.env.DIRECTOR_BUNDLE_ALL === '1' ? false : { exclude: workspace };

export default defineConfig({
  main: {
    build: {
      externalizeDeps: externalize,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      externalizeDeps: externalize,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    worker: { format: 'es' },
    build: {
      // Worklets and workers must load from files: the CSP does not allow data: scripts.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          prompter: resolve(__dirname, 'src/renderer/prompter.html'),
        },
      },
    },
  },
});
