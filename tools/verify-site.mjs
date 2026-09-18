#!/usr/bin/env node
/** 公開用トップページの検証。環境チェックが GPU 有無を正しく判定するか。 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.csv':'text/csv','.svg':'image/svg+xml' };
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));
const root = resolve(process.argv[2] ?? 'site-build');

const server = createServer(async (req, rep) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const p = join(root, u.endsWith('/') ? u + 'index.html' : u);
    const st = await stat(p);
    const buf = await readFile(p);
    const type = MIME[extname(p)] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const s0 = Number(m[1]), e0 = m[2] ? Number(m[2]) : st.size - 1;
      rep.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s0}-${e0}/${st.size}`, 'Accept-Ranges': 'bytes' });
      rep.end(buf.subarray(s0, e0 + 1));
    } else { rep.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes' }); rep.end(buf); }
  } catch { rep.writeHead(404); rep.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const record = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? '✔' : '✘'} ${n}${d ? `  — ${d}` : ''}`); };

for (const software of [false, true]) {
  const label = software ? 'ソフトウェア描画' : 'GPU 描画';
  const args = ['--no-sandbox'];
  if (software) args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const br = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args });
  const p = await br.newPage();
  await p.setViewport({ width: 900, height: 1100 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(base + '/', { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  const info = await p.evaluate(() => ({
    verdict: document.getElementById('verdict')?.textContent ?? '',
    cls: document.getElementById('check')?.className ?? '',
    envRows: document.querySelectorAll('#env dt').length,
    renderer: [...document.querySelectorAll('#env dt')].find((d) => d.textContent === '描画装置')?.nextElementSibling?.textContent ?? '',
    links: [...document.querySelectorAll('a.btn')].map((a) => a.getAttribute('href')),
  }));
  console.log(`\n--- ${label} ---`);
  console.log(`  判定: ${info.verdict}`);
  console.log(`  描画装置: ${info.renderer.slice(0, 70)}`);
  const want = software ? /warn/ : /ok/;
  record(`${label}: 判定が正しい`, want.test(info.cls), info.cls);
  record(`${label}: 環境情報が出る`, info.envRows >= 5, `${info.envRows} 項目`);
  record(`${label}: JS エラーがない`, errs.length === 0, errs.slice(0, 2).join(' | '));
  if (!software) {
    await p.screenshot({ path: 'docs/screenshots/site-top.png', fullPage: true });
    // リンク先が生きているか
    for (const href of info.links) {
      const res = await p.goto(base + '/' + href.replace(/^\//, ''), { waitUntil: 'domcontentloaded', timeout: 120000 });
      record(`リンクが生きている: ${href}`, res.status() < 400, `HTTP ${res.status()}`);
    }
  }
  await br.close();
}
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 件 合格`);
if (failed.length) process.exit(1);
