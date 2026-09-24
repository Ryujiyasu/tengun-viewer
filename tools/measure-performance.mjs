#!/usr/bin/env node
/**
 * P0 の目的そのもの: 動作環境の実測値を取る。
 *   - 変換〜表示までの所要時間
 *   - ブラウザのメモリ使用量
 *   - 描画速度（GPU 描画時 / ソフトウェア描画時の両方）
 *
 * ソフトウェア描画の値は「庁内 PC でハードウェアアクセラレータが切られている場合」の目安。
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { findChrome, chromeArgs } from './lib/chrome.mjs';

const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.csv':'text/csv','.svg':'image/svg+xml' };

function serve(rootDir) {
  return new Promise((res) => {
    const server = createServer(async (req, rep) => {
      try {
        const url = decodeURIComponent(req.url.split('?')[0]);
        const path = join(rootDir, url === '/' ? 'index.html' : url);
        const st = await stat(path);
        const type = MIME[extname(path)] ?? 'application/octet-stream';
        const range = req.headers.range;
        const buf = await readFile(path);
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const s0 = Number(m[1]); const e0 = m[2] ? Number(m[2]) : st.size - 1;
          rep.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s0}-${e0}/${st.size}`, 'Accept-Ranges': 'bytes' });
          rep.end(buf.subarray(s0, e0 + 1));
        } else {
          rep.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes' });
          rep.end(buf);
        }
      } catch { rep.writeHead(404); rep.end(); }
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

const CHROME = findChrome();

async function measure(url, { software }) {
  const extra = software ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
  const args = chromeArgs(extra);
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  const tLoad = Date.now() - t0;
  // 最初の点が出るまで
  await page.waitForFunction(() => /読み込み済み [1-9]/.test(document.getElementById('status')?.textContent ?? ''), { timeout: 180000 });
  const tFirstPoints = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 9000)); // LOD が落ち着くまで

  const res = await page.evaluate(async () => {
    // 60 フレーム分の実測 fps
    const frames = [];
    await new Promise((done) => {
      let n = 0, last = performance.now();
      const tick = () => {
        const now = performance.now();
        frames.push(now - last); last = now;
        if (++n >= 60) return done();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    frames.sort((a, b) => a - b);
    const median = frames[Math.floor(frames.length / 2)];
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      fpsMedian: 1000 / median,
      status: document.getElementById('status')?.textContent?.trim() ?? '',
      memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      limitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl?.getParameter(gl.RENDERER) ?? '不明'),
      loadedPoints: Number((document.getElementById('status')?.textContent.match(/読み込み済み ([\d,]+)/)?.[1] ?? '0').replace(/,/g, '')),
    };
  });
  await browser.close();
  return { ...res, tLoadMs: tLoad, tFirstPointsMs: tFirstPoints };
}

const base = resolve(process.argv[2] ?? 'dist/sample');
const rows = [];
const { server, port } = await serve(join(base, 'full'));

for (const software of [false, true]) {
  const label = software ? 'ソフトウェア描画' : 'GPU 描画';
  console.log(`\n--- フル版 / ${label} ---`);
  const r = await measure(`http://127.0.0.1:${port}/`, { software });
  console.log(`  描画装置        ${r.renderer}`);
  console.log(`  ページ読み込み  ${(r.tLoadMs / 1000).toFixed(2)} s`);
  console.log(`  最初の点が出る  ${(r.tFirstPointsMs / 1000).toFixed(2)} s`);
  console.log(`  描画速度        ${r.fpsMedian.toFixed(1)} fps`);
  console.log(`  読み込み済み点数 ${r.loadedPoints.toLocaleString()}`);
  console.log(`  JS ヒープ       ${r.memoryMB} MB / 上限 ${r.limitMB} MB`);
  rows.push({ profile: 'full', mode: label, ...r });
}
server.close();

const lightFile = join(base, 'light', 'index.html');
if (existsSync(lightFile)) {
  const size = (await stat(lightFile)).size;
  for (const software of [false, true]) {
    const label = software ? 'ソフトウェア描画' : 'GPU 描画';
    console.log(`\n--- 軽量版 (file://, ${(size / 1048576).toFixed(1)} MB) / ${label} ---`);
    const r = await measure(`file://${lightFile}`, { software });
    console.log(`  ページ読み込み  ${(r.tLoadMs / 1000).toFixed(2)} s`);
    console.log(`  最初の点が出る  ${(r.tFirstPointsMs / 1000).toFixed(2)} s`);
    console.log(`  描画速度        ${r.fpsMedian.toFixed(1)} fps`);
    console.log(`  読み込み済み点数 ${r.loadedPoints.toLocaleString()}`);
    console.log(`  JS ヒープ       ${r.memoryMB} MB / 上限 ${r.limitMB} MB`);
    rows.push({ profile: 'light', mode: label, htmlBytes: size, ...r });
  }
}

await writeFile(join(base, 'performance.json'), JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2));
console.log(`\n実測値を ${join(base, 'performance.json')} に保存しました。`);
