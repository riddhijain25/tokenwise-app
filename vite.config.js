import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'src/index.html'),
        login: resolve(process.cwd(), 'src/login.html'),
      },
    },
  },
  server: {
    proxy: {
      '^/chat$': { target: 'http://localhost:3000', changeOrigin: true },
      '^/models$': { target: 'http://localhost:3000', changeOrigin: true },
      '^/update-profile$': { target: 'http://localhost:3000', changeOrigin: true },
      '^/get-profile$': { target: 'http://localhost:3000', changeOrigin: true },
      '^/get-current-user$': { target: 'http://localhost:3000', changeOrigin: true },
      '^/telemetry$': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});