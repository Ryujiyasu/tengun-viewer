#!/usr/bin/env node
/**
 * 取り込み機能の検証。
 * ビューアに LAS/LAZ と設計 LandXML を投入し、CLI で変換した場合と
 * 同じ判定値が出るところまで確認する。数字が一致しなければ意味がない。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.csv':'text/csv','.svg':'image/svg+xml' };
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean).find((p) => existsSync(p));

function serve(rootDir) {
  return new Promise((res) => {
    const server = createServer(async (req, rep) => {
      try {
        const url = decodeURIComponent(req.url.split('?')[0]);
        const path = join(rootDir, url === '/' ? 'index.html' : url);
        const st = await stat(path);
        const buf = await readFile(path);
        const type = MIME[extname(path)] ?? 'application/octet-stream';
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const s0 = Number(m[1]), e0 = m[2] ? Number(m[2]) : st.size - 1;
          rep.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s0}-${e0}/${st.size}`, 'Accept-Ranges': 'bytes' });
          rep.end(buf.subarray(s0, e0 + 1));
        } else { rep.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes' }); rep.end(buf); }
      } catch { rep.writeHead(404); rep.end(); }
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

const viewerDir = resolve(process.argv[2] ?? 'dist/sample/full');
const dataDir = resolve(process.argv[3] ?? 'fixtures');
const shotDir = resolve(process.argv[4] ?? 'docs/screenshots');
const pointsFile = process.argv[5] ?? join(dataDir, '出来形.las');

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  — ${detail}` : ''}`); };

const { server, port } = await serve(viewerDir);
const browser = await puppeteer.launch({
  headless: 'new', executablePath: CHROME,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 120000 });
await new Promise((r) => setTimeout(r, 4000));

// 「データを開く」パネルを開く
const opened = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('.panel-head')];
  const h = heads.find((x) => x.textContent.includes('データを開く'));
  if (!h) return false;
  if (!h.parentElement.classList.contains('open')) h.click();
  return true;
});
record('「データを開く」パネルがある', opened);

const input = await page.$('.dropzone input[type=file]');
record('ファイル選択欄がある', !!input);
if (!input) { await browser.close(); server.close(); process.exit(1); }

const files = [pointsFile, join(dataDir, '設計.xml'), join(dataDir, '工事情報.json')].filter((f) => existsSync(f));
console.log(`  投入: ${files.map((f) => f.split('/').pop()).join(', ')}`);
await input.uploadFile(...files);
await new Promise((r) => setTimeout(r, 800));

const slots = await page.evaluate(() =>
  [...document.querySelectorAll('.slot')].map((s) => s.querySelector('.slot-file')?.textContent));
record('投入したファイルが認識されている', slots.filter((s) => s && s !== '未選択').length >= 2, slots.filter(Boolean).join(' / '));

const btnEnabled = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.btn.primary')].find((x) => x.textContent.includes('読み込んで'));
  return b && !b.hasAttribute('disabled');
});
record('計算ボタンが押せる状態になる', btnEnabled);

const t0 = Date.now();
await page.evaluate(() => {
  [...document.querySelectorAll('.btn.primary')].find((x) => x.textContent.includes('読み込んで'))?.click();
});

// 判定表が取り込み結果で描き直されるまで待つ
await page.waitForFunction(
  () => /ブラウザ取り込み/.test(document.querySelector('#status')?.textContent ?? '')
     || /ブラウザ取り込み/.test([...document.querySelectorAll('.stat-list dd')].map((d) => d.textContent).join(' ')),
  { timeout: 300000, polling: 800 }
).catch(() => {});
await new Promise((r) => setTimeout(r, 5000));
const elapsed = Date.now() - t0;

const after = await page.evaluate(() => {
  const dd = [...document.querySelectorAll('.stat-list dt')].map((dt, i) => [dt.textContent, dt.nextElementSibling?.textContent]);
  const rows = [...document.querySelectorAll('.judge-table tbody tr')].map((tr) =>
    [...tr.children].map((td) => td.textContent.trim()));
  // 様式-31-2 は部位ごとにブロックが分かれるので、部位名とセットで拾う
  const partRows = [...document.querySelectorAll('.part-block')].flatMap((b) => {
    const part = b.querySelector('.part-title span')?.textContent ?? '';
    return [...b.querySelectorAll('tbody tr')].map((tr) => ({
      part, label: tr.children[0].textContent.trim(), value: tr.children[1].textContent.trim(),
    }));
  });
  const canvas = document.querySelector('.canvas-host canvas');
  let nonBg = 0, tot = 0;
  if (canvas) {
    const c2 = document.createElement('canvas');
    c2.width = canvas.width; c2.height = canvas.height;
    const ctx = c2.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, c2.width, c2.height).data;
    for (let i = 0; i < d.length; i += 4 * 97) { tot++; if (Math.abs(d[i] - 242) > 6 || Math.abs(d[i + 1] - 244) > 6) nonBg++; }
  }
  return {
    diagnostics: Object.fromEntries(dd),
    rows,
    partRows,
    verdict: document.querySelector('.sheet-verdict')?.textContent ?? document.querySelector('.badge')?.textContent ?? '',
    status: document.querySelector('#status')?.textContent?.trim() ?? '',
    importMsg: document.querySelector('.import-status')?.textContent ?? '',
    nonBg, tot,
  };
});

// 取り込みが済むと画面ごと作り直されるので、診断情報の「ビューア」欄で判定する
const viewerLabel = after.diagnostics['ビューア'] ?? '';
record('取り込みが完了する', /ブラウザ取り込み/.test(viewerLabel), viewerLabel || '(診断情報なし)');
record('取り込んだ点が描画される', after.nonBg > after.tot * 0.02, `背景以外 ${after.nonBg}/${after.tot}`);
record('判定表が出る', after.rows.length >= 1, `${after.rows.length} 行 / ${after.verdict}`);
record('JS エラーがない', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`   所要 ${(elapsed / 1000).toFixed(1)} 秒`);
console.log(`   ステータス: ${after.status}`);

// CLI の結果と突き合わせる
const cliJson = process.argv[6];
if (cliJson && existsSync(cliJson)) {
  const cfg = JSON.parse(await readFile(cliJson, 'utf8'));
  const want = [];
  for (const p of cfg.sheet?.parts ?? []) for (const r of p.rows) want.push([`${p.name}|${r.label}`, r.value]);
  const got = new Map(after.partRows.map((r) => [`${r.part}|${r.label}`, Number(r.value)]));
  let match = 0, checked = 0;
  for (const [label, v] of want) {
    if (!got.has(label) || !Number.isFinite(v)) continue;
    checked++;
    if (Math.abs(got.get(label) - v) < 0.15) match++;
  }
  record('CLI 変換と判定値が一致する', checked > 0 && match === checked, `${match}/${checked} 項目一致`);
}

await page.screenshot({ path: join(shotDir, 'import.png') });
await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 件 合格`);
if (failed.length) process.exit(1);
