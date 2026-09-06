import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/chat': 'http://localhost:3000',
      '/models': 'http://localhost:3000',
    },
  },
});
