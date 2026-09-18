#!/usr/bin/env node
/** 公開URLで実際に動くかを確認する。ローカルで動いても本番で動くとは限らない。 */
import puppeteer from 'puppeteer';
import { grabCanvasRgb, contentStats } from './lib/pixels.mjs';
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

// --- ビューア（URL を開くとそのまま立ち上がる）---
console.log(`\n== ${BASE} ==`);
let t0 = Date.now();
const r1 = await page.goto(BASE, { waitUntil: 'load', timeout: 180000 });
record('ビューアが開く', r1.status() === 200, `HTTP ${r1.status()} / ${((Date.now() - t0) / 1000).toFixed(2)} s`);
await new Promise((r) => setTimeout(r, 2500));

// 起動時の動作確認ダイアログ
const env = await page.evaluate(() => {
  const m = document.querySelector('.modal.show');
  if (!m) return null;
  return {
    mark: m.querySelector('.env-mark')?.textContent ?? '',
    title: m.querySelector('.env-head h2')?.textContent ?? '',
    renderer: [...m.querySelectorAll('.env-kv dt')].find((d) => d.textContent === '描画装置')?.nextElementSibling?.textContent ?? '',
  };
});
record('起動時に動作確認が出る', !!env && /[○△×]/.test(env.mark), env ? `${env.mark} ${env.title}` : '(出なかった)');
if (env) console.log(`   描画装置: ${env.renderer.slice(0, 70)}`);
await page.evaluate(() => document.querySelector('.modal.show .btn.primary')?.click());

await page.waitForFunction(() => /読み込み済み [1-9]/.test(document.getElementById('status')?.textContent ?? ''), { timeout: 180000 }).catch(() => {});
const firstPoints = ((Date.now() - t0) / 1000).toFixed(2);
await new Promise((r) => setTimeout(r, 9000));
const v = await page.evaluate(() => ({
  status: document.getElementById('status')?.textContent?.trim() ?? '',
  verdict: document.querySelector('.sheet-verdict')?.textContent ?? '',
  parts: document.querySelectorAll('.part-block').length,
  title: document.querySelector('.project-name')?.textContent ?? '',
  logo: !!document.querySelector('.brand-logo svg'),
  openBtn: !!document.getElementById('open-data-btn'),
}));
const px = contentStats(await grabCanvasRgb(page, { w: 220, h: 140 }));
record('点群が描画される', px.nonBgRatio > 0.05 && px.distinctColors > 12,
  `背景以外 ${(px.nonBgRatio * 100).toFixed(1)}% / 最初の点まで ${firstPoints} s`);
record('判定表（様式-31-2）が出る', v.parts >= 1, `${v.parts} 部位 / ${v.verdict}`);
record('ロゴと「データを開く」がある', v.logo && v.openBtn);
record('JS エラーがない', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`   ${v.title}`);
console.log(`   ${v.status}`);

// --- 帳票 CSV ---
const csv = await page.evaluate(async (base) => {
  const res = await fetch(base + 'report/出来形合否判定総括表.csv');
  return { ok: res.ok, status: res.status, head: (await res.text()).slice(0, 60) };
}, BASE);
record('帳票 CSV が取得できる', csv.ok, `HTTP ${csv.status} / ${csv.head.replace(/[\r\n]+/g, ' ').slice(0, 40)}`);

// --- 単一HTML版 ---
console.log(`\n== ${BASE}light/index.html ==`);
t0 = Date.now();
const r3 = await page.goto(BASE + 'light/index.html', { waitUntil: 'load', timeout: 300000 });
record('単一HTML版が開く', r3.status() === 200, `HTTP ${r3.status()} / ${((Date.now() - t0) / 1000).toFixed(2)} s`);
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => document.querySelector('.modal.show .btn.primary')?.click());
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
