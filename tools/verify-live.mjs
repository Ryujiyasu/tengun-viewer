#!/usr/bin/env node
/** 公開URLで実際に動くかを確認する。ローカルで動いても本番で動くとは限らない。 */
import puppeteer from 'puppeteer';
import { existsSync } from 'node:fs';
const BASE = process.argv[2] ?? 'https://ryujiyasu.github.io/tengun-viewer/';
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));
const results = [];
const record = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? '✔' : '✘'} ${n}${d ? `  — ${d}` : ''}`); };

const br = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

// --- トップページ ---
console.log(`\n== ${BASE} ==`);
let t0 = Date.now();
const r1 = await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
record('トップページが開く', r1.status() === 200, `HTTP ${r1.status()} / ${((Date.now() - t0) / 1000).toFixed(2)} s`);
await new Promise((r) => setTimeout(r, 1500));
const top = await page.evaluate(() => ({
  verdict: document.getElementById('verdict')?.textContent ?? '',
  cls: document.getElementById('check')?.className ?? '',
  renderer: [...document.querySelectorAll('#env dt')].find((d) => d.textContent === '描画装置')?.nextElementSibling?.textContent ?? '',
}));
record('環境チェックが判定を出す', /[○△×]/.test(top.verdict), top.verdict);
console.log(`   描画装置: ${top.renderer.slice(0, 70)}`);

// --- ビューア（フル版） ---
console.log(`\n== ${BASE}full/ ==`);
t0 = Date.now();
const r2 = await page.goto(BASE + 'full/', { waitUntil: 'load', timeout: 180000 });
record('ビューアが開く', r2.status() === 200, `HTTP ${r2.status()} / ${((Date.now() - t0) / 1000).toFixed(2)} s`);
await page.waitForFunction(() => /読み込み済み [1-9]/.test(document.getElementById('status')?.textContent ?? ''), { timeout: 180000 }).catch(() => {});
const firstPoints = ((Date.now() - t0) / 1000).toFixed(2);
await new Promise((r) => setTimeout(r, 9000));
const v = await page.evaluate(() => {
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
    status: document.getElementById('status')?.textContent?.trim() ?? '',
    verdict: document.querySelector('.sheet-verdict')?.textContent ?? '',
    parts: document.querySelectorAll('.part-block').length,
    title: document.querySelector('.project-name')?.textContent ?? '',
    nonBg, tot,
  };
});
record('点群が描画される', v.nonBg > v.tot * 0.02, `背景以外 ${v.nonBg}/${v.tot} / 最初の点まで ${firstPoints} s`);
record('判定表（様式-31-2）が出る', v.parts >= 1, `${v.parts} 部位 / ${v.verdict}`);
record('JS エラーがない', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`   ${v.title}`);
console.log(`   ${v.status}`);

// --- 帳票 CSV ---
const csv = await page.evaluate(async (base) => {
  const res = await fetch(base + 'full/report/出来形合否判定総括表.csv');
  return { ok: res.ok, status: res.status, head: (await res.text()).slice(0, 60) };
}, BASE);
record('帳票 CSV が取得できる', csv.ok, `HTTP ${csv.status} / ${csv.head.replace(/[\r\n]+/g, ' ').slice(0, 40)}`);

// --- 単一HTML版 ---
console.log(`\n== ${BASE}light/index.html ==`);
t0 = Date.now();
const r3 = await page.goto(BASE + 'light/index.html', { waitUntil: 'load', timeout: 300000 });
record('単一HTML版が開く', r3.status() === 200, `HTTP ${r3.status()} / ${((Date.now() - t0) / 1000).toFixed(2)} s`);
await new Promise((r) => setTimeout(r, 8000));
const l = await page.evaluate(() => ({
  status: document.getElementById('status')?.textContent?.trim() ?? '',
  parts: document.querySelectorAll('.part-block').length,
}));
record('単一HTML版でも判定が出る', l.parts >= 1, `${l.parts} 部位`);
console.log(`   ${l.status}`);

await br.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 件 合格`);
if (failed.length) process.exit(1);
