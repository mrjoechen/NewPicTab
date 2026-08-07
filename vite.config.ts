import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  build: {
    target: 'chrome111',
    cssTarget: 'chrome111',
    rollupOptions: {
      input: {
        newtab: fileURLToPath(new URL('newtab.html', import.meta.url)),
        background: fileURLToPath(new URL('src/background/index.ts', import.meta.url))
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
