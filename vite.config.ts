import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = `http://127.0.0.1:${env.PORT || process.env.PORT || 8787}`;

  return {
    plugins: [react()],
    build: {
      manifest: true,
      rollupOptions: {
        input: { app: 'index.html', browserScene: 'src/browserScene.ts' },
        preserveEntrySignatures: 'strict'
      }
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
        '/_AMapService': apiTarget
      }
    }
  };
});
