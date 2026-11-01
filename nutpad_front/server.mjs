// Minimal static server for the built SPA (Railway). Zero dependencies.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPreview } from './og.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const port = Number(process.env.PORT ?? 4173);
const apiUrl = (process.env.VITE_API_URL ?? process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(root, 'index.html'); // SPA fallback
  }
  try {
    let body = await readFile(file);
    const ext = extname(file);
    if (ext === '.html') {
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
      const origin = publicUrl || `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
      body = Buffer.from(await withPreview(body.toString('utf8'), { origin, apiUrl, path: url.pathname }));
    }
    res.writeHead(200, {
      'Content-Type': types[ext] ?? 'application/octet-stream',
      'Cache-Control': file.includes(`${join(root, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  } catch {
    res.writeHead(500).end('error');
  }
}).listen(port, '0.0.0.0', () => console.log(`nutpad-front on :${port}`));
