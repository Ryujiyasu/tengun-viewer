#!/usr/bin/env node
/**
 * 表示設定が実際に画面へ反映されるかを確認する。
 *
 * three.js は同じマテリアルを共有する描画でユニフォームを再送しないため、
 * uniforms.X.value を書き換えただけでは何も起きない。これを取り逃すと
 * 「色分けを変えても画面が変わらない」状態のまま出荷してしまう。
 * 操作ごとにキャンバスの画素が変わったかを実測して確かめる。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { findChrome, chromeArgs } from './lib/chrome.mjs';
import { grabCanvasRgb, frameDistance } from './lib/pixels.mjs';

const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.csv':'text/csv','.svg':'image/svg+xml' };
const CHROME = findChrome();
const root = resolve(process.argv[2] ?? 'site-build/full');

const server = createServer(async (q, p) => {
  try {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const f = join(root, u === '/' ? 'index.html' : u);
    const st = await stat(f); const b = await readFile(f);
    const t = MIME[extname(f)] ?? 'application/octet-stream';
    const r = q.headers.range;
    if (r) {
      const m = /bytes=(\d+)-(\d*)/.exec(r); const s0 = +m[1], e0 = m[2] ? +m[2] : st.size - 1;
      p.writeHead(206, { 'Content-Type': t, 'Content-Range': `bytes ${s0}-${e0}/${st.size}`, 'Accept-Ranges': 'bytes' });
      p.end(b.subarray(s0, e0 + 1));
    } else { p.writeHead(200, { 'Content-Type': t, 'Accept-Ranges': 'bytes' }); p.end(b); }
  } catch { p.writeHead(404); p.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const br = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: chromeArgs() });
const page = await br.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => /読み込み済み [1-9]/.test(document.getElementById('status')?.textContent ?? ''), { timeout: 120000 });
await sleep(8000);

// 画面の指紋は合成後のスクリーンショットから取る（ページ内の canvas 読み出しは空になる）
const fingerprint = () => grabCanvasRgb(page, { w: 200, h: 130 });
const distance = frameDistance;

const results = [];
async function expectChange(name, act, min = 0.0015) {
  const before = await fingerprint();
  await act();
  await sleep(2200);
  const after = await fingerprint();
  const d = distance(before, after);
  const ok = d >= min;
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}  — 画面の変化量 ${d.toFixed(5)}（しきい値 ${min}）`);
  return d;
}

const selectColor = async (label) => page.evaluate((l) => {
  const s = [...document.querySelectorAll('select.select')].find((x) => [...x.options].some((o) => o.textContent.includes(l)));
  const o = [...s.options].find((x) => x.textContent.includes(l));
  s.value = o.value;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, label);

const toggle = async (label) => page.evaluate((l) => {
  const c = [...document.querySelectorAll('.check')].find((x) => x.textContent.includes(l));
  if (!c) throw new Error('見つからない: ' + l);
  c.querySelector('input').click();
}, label);

console.log('表示設定の反映を確認します\n');
await expectChange('色分け: 標高', () => selectColor('標高'));
await expectChange('色分け: RGB（実写色）', () => selectColor('RGB'));
await expectChange('色分け: 反射強度', () => selectColor('反射強度'));
await expectChange('色分け: クラス分類', () => selectColor('クラス分類'));
await expectChange('色分け: 設計との較差（判定に使う方式）', () => selectColor('判定に使う方式'));
await expectChange('色分け: 法線方向較差に切替', () => selectColor('法線方向'));
await expectChange('色分け: 判定方式に戻す', () => selectColor('判定に使う方式'));

await expectChange('色域スライダー', () => page.evaluate(() => {
  const s = document.querySelectorAll('.slider')[0];
  s.value = '15';
  s.dispatchEvent(new Event('input', { bubbles: true }));
}));

await expectChange('点サイズ', () => page.evaluate(() => {
  const s = document.querySelectorAll('.slider')[1];
  s.value = '6';
  s.dispatchEvent(new Event('input', { bubbles: true }));
}));

await expectChange('点密度', () => page.evaluate(() => {
  const s = document.querySelectorAll('.slider')[2];
  s.value = '25';
  s.dispatchEvent(new Event('input', { bubbles: true }));
}));
await page.evaluate(() => {
  const s = document.querySelectorAll('.slider')[2];
  s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true }));
  const p = document.querySelectorAll('.slider')[1];
  p.value = '2'; p.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(1500);

await expectChange('地表面のみ表示', () => toggle('地表面のみ表示'));
await expectChange('地表面のみ表示（戻す）', () => toggle('地表面のみ表示'));
await expectChange('規格値内を淡色にする', () => toggle('規格値内を淡色'));
await expectChange('規格値内を淡色にする（戻す）', () => toggle('規格値内を淡色'));
await expectChange('設計面を重ねる', () => toggle('設計面を重ねる'));
await expectChange('点群の切替（出来形→起工測量）', () => page.evaluate(() => {
  const s = [...document.querySelectorAll('select.select')].find((x) => [...x.options].some((o) => o.textContent.includes('起工測量')));
  s.value = 'pre';
  s.dispatchEvent(new Event('change', { bubbles: true }));
}));
await expectChange('3D へ切替', () => page.click('.tab[data-view="3d"]'));

results.push({ name: 'JS エラーがない', ok: errs.length === 0 });
console.log(`${errs.length === 0 ? '✔' : '✘'} JS エラーがない${errs.length ? '  — ' + errs.slice(0, 3).join(' | ') : ''}`);

await br.close(); server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 件 合格`);
if (failed.length) { console.log('反映されていない操作:'); for (const f of failed) console.log('  - ' + f.name); process.exit(1); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
