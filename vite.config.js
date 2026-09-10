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
      '/update-profile': 'http://localhost:3000',
      '/get-profile': 'http://localhost:3000',
      '/get-current-user': 'http://localhost:3000',
      '/telemetry': 'http://localhost:3000',
    },
  },
});
