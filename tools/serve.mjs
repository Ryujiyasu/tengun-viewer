#!/usr/bin/env node
/**
 * 検証用の静的 HTTP サーバ。
 *
 * 「方式C（閉域内の Web サーバに配置）」と同じ条件を手元で再現する。
 * Range リクエストに対応しているので、octree の部分読み込みがそのまま効く。
 * これは開発・確認用であって、納品物には含めない。
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    // ルート外への参照を防ぐ
    const path = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!path.startsWith(root)) { res.writeHead(403).end('Forbidden'); return; }

    const st = await stat(path);
    if (st.isDirectory()) { res.writeHead(301, { Location: rel + '/' }).end(); return; }

    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    createReadStream(path).pipe(res);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e.code === 'ENOENT' ? '404 Not Found' : `500 ${e.message}`);
  }
});

server.listen(port, () => {
  console.log(`配信中: ${root}`);
  console.log(`  http://localhost:${port}/`);
});
