import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { handleRoomRequest } from './lib/rooms.js';
import { openRoomStore } from './lib/rooms-local.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const db = openRoomStore(process.env.ROOM_DB || 'data/rooms.sqlite');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/')) {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      }
      const hasBody = !['HEAD', 'GET'].includes(req.method);
      const request = new Request(url, {
        method: req.method, headers,
        ...(hasBody ? {body: Readable.toWeb(req), duplex: 'half'} : {}),
      });
      const response = await handleRoomRequest(db, request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {Allow: 'GET, HEAD'}).end();
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/arena.html' : url.pathname));
    if (!path.startsWith(resolve(root) + sep) || !types[extname(path)]) {
      res.writeHead(404).end();
      return;
    }
    const file = await readFile(path);
    res.writeHead(200, {
      'Content-Type': types[extname(path)],
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : err instanceof URIError ? 400 : 500).end();
  }
});
server.listen(port, host, () => console.log('Riftbound is listening on port ' + server.address().port));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
