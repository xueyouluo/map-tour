import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = `http://127.0.0.1:${env.PORT || process.env.PORT || 8787}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/_AMapService': apiTarget
      }
    }
  };
});
