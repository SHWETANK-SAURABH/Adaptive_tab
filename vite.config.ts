import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { popup: 'index.html', background: 'src/background/service-worker.ts' },
      output: { entryFileNames: (chunk) => chunk.name === 'background' ? 'service-worker.js' : 'assets/[name]-[hash].js' }
    }
  }
});
