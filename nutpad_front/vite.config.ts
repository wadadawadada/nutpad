import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { withPreview } from './og.mjs';

const ogDev = () => ({
  name: 'og-preview-dev',
  configureServer(server: any) {
    server.middlewares.use(async (req: any, res: any, next: any) => {
      const path = String(req.url ?? '').split('?')[0];
      if (req.method !== 'GET' || !/^\/token\/[0-9a-f]{64}\/?$/.test(path)) return next();
      const raw = readFileSync('index.html', 'utf8');
      const html = await server.transformIndexHtml(req.url, raw);
      const apiUrl = (process.env.VITE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(await withPreview(html, { origin: `http://${req.headers.host}`, apiUrl, path }));
    });
  },
});

export default defineConfig({
  plugins: [react(), ogDev()],
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
