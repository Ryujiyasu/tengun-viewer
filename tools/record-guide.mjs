#!/usr/bin/env node
/**
 * 使い方の動画とキャプチャを自動生成する。
 *
 * ビューアを実際に操作しながら画面を録画し、節目でキャプチャも残す。
 * 手で撮り直さなくても、画面を直せば説明書と動画が作り直せる状態にしておく。
 *
 *   node tools/record-guide.mjs [viewerDir] [outDir]
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.csv':'text/csv','.svg':'image/svg+xml' };
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));

const viewerDir = resolve(process.argv[2] ?? 'site-build/full');
const outDir = resolve(process.argv[3] ?? 'docs/guide');
const framesDir = join(outDir, '.frames');
const W = 1280, H = 800, FPS = 24;

await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });
await mkdir(join(outDir, 'capture'), { recursive: true });

// --- 静的サーバ（Range 対応） ---
const server = createServer(async (req, rep) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const p = join(viewerDir, u === '/' ? 'index.html' : u);
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
  } catch { rep.writeHead(404); rep.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  headless: 'new', executablePath: CHROME,
  args: ['--no-sandbox', `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(BASE, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => /読み込み済み [1-9]/.test(document.getElementById('status')?.textContent ?? ''), { timeout: 180000 });
await sleep(6000);
// 起動ダイアログを最初の説明に使うので、出ていなければ出し直す
await page.evaluate(() => {
  const m = document.querySelector('.modal');
  if (m && !m.classList.contains('show')) m.classList.add('show');
});
await sleep(800);

// --- 画面に字幕とカーソルを重ねる ---
await page.evaluate(() => {
  const style = document.createElement('style');
  style.textContent = `
  #gd-cap{position:fixed;left:0;right:0;bottom:0;z-index:99999;
    background:linear-gradient(to top,rgba(16,24,34,.94),rgba(16,24,34,.86));
    color:#fff;padding:16px 28px 18px;font-size:21px;font-weight:700;line-height:1.5;
    font-family:"Yu Gothic UI","Meiryo","Hiragino Sans",system-ui,sans-serif;
    transform:translateY(120%);transition:transform .32s ease;pointer-events:none}
  #gd-cap.on{transform:translateY(0)}
  #gd-cap .sub{display:block;font-size:14.5px;font-weight:400;opacity:.85;margin-top:4px}
  #gd-step{position:fixed;left:0;top:0;z-index:99999;background:#1f5fa8;color:#fff;
    padding:5px 16px;font-size:14px;font-weight:700;border-bottom-right-radius:6px;
    font-family:"Yu Gothic UI","Meiryo",system-ui,sans-serif;opacity:0;transition:opacity .25s}
  #gd-step.on{opacity:1}
  #gd-cur{position:fixed;z-index:99998;width:22px;height:22px;margin:-11px 0 0 -11px;
    border-radius:50%;border:2.5px solid #1f5fa8;background:rgba(31,95,168,.28);
    pointer-events:none;opacity:0;transition:opacity .2s}
  #gd-cur.on{opacity:1}
  #gd-cur.click{animation:gdclick .45s ease}
  @keyframes gdclick{0%{transform:scale(1)}40%{transform:scale(1.9);background:rgba(31,95,168,.5)}100%{transform:scale(1)}}
  #gd-ring{position:fixed;z-index:99997;border:3px solid #e8a33d;border-radius:8px;
    pointer-events:none;opacity:0;transition:opacity .25s;box-shadow:0 0 0 9999px rgba(16,24,34,.32)}
  #gd-ring.on{opacity:1}`;
  document.head.appendChild(style);
  for (const id of ['gd-cap', 'gd-step', 'gd-cur', 'gd-ring']) {
    const el = document.createElement('div'); el.id = id; document.body.appendChild(el);
  }
  window.__gd = {
    cap(text, sub) {
      const c = document.getElementById('gd-cap');
      c.innerHTML = text ? text + (sub ? `<span class="sub">${sub}</span>` : '') : '';
      c.classList.toggle('on', !!text);
    },
    step(t) { const s = document.getElementById('gd-step'); s.textContent = t || ''; s.classList.toggle('on', !!t); },
    cur(x, y, show = true) {
      const c = document.getElementById('gd-cur');
      c.style.left = x + 'px'; c.style.top = y + 'px'; c.classList.toggle('on', show);
    },
    click() {
      const c = document.getElementById('gd-cur');
      c.classList.remove('click'); void c.offsetWidth; c.classList.add('click');
    },
    ring(sel) {
      const r = document.getElementById('gd-ring');
      if (!sel) { r.classList.remove('on'); return; }
      const el = document.querySelector(sel);
      if (!el) { r.classList.remove('on'); return; }
      const b = el.getBoundingClientRect();
      r.style.left = (b.left - 5) + 'px'; r.style.top = (b.top - 5) + 'px';
      r.style.width = (b.width + 10) + 'px'; r.style.height = (b.height + 10) + 'px';
      r.classList.add('on');
    },
  };
});

// --- 録画開始 ---
const client = await page.createCDPSession();
let frame = 0;
// 画面は 60fps で更新されるため、フレーム数をそのまま固定 fps で並べると
// 実時間の倍以上に伸びる。各フレームの実時刻を持たせて後で正しい尺に組む。
const frames = [];
client.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
  const n = String(++frame).padStart(5, '0');
  const file = `f${n}.jpg`;
  await writeFile(join(framesDir, file), Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
  try { await client.send('Page.screencastFrameAck', { sessionId }); } catch {}
});
await client.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

const captures = [];
/**
 * 静止画は字幕・手順チップ・カーソルを隠して撮る。
 * 説明書に貼ると、動画用のテロップが本文と二重になって読みにくいため。
 * 録画の側には字幕を残す（一瞬だけ隠して撮り、すぐ戻す）。
 */
async function capture(name, title) {
  const file = `capture/${name}.png`;
  await page.evaluate(() => {
    for (const id of ['gd-cap', 'gd-step', 'gd-ring', 'gd-cur']) {
      const el = document.getElementById(id);
      if (el) { el.dataset.gdPrev = el.style.visibility || ''; el.style.visibility = 'hidden'; }
    }
  });
  await sleep(120);
  await page.screenshot({ path: join(outDir, file) });
  await page.evaluate(() => {
    for (const id of ['gd-cap', 'gd-step', 'gd-ring', 'gd-cur']) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = el.dataset.gdPrev ?? '';
    }
  });
  await sleep(120);
  captures.push({ name, title, file });
  console.log(`  capture: ${name}`);
}
async function cap(text, sub, ms = 2900) {
  await page.evaluate((t, s) => window.__gd.cap(t, s), text, sub ?? '');
  await sleep(ms);
}
async function step(t) { await page.evaluate((x) => window.__gd.step(x), t); }
async function ring(sel) { await page.evaluate((s) => window.__gd.ring(s), sel); }
async function moveTo(x, y, steps = 26) {
  const cur = moveTo._last ?? { x: W / 2, y: H / 2 };
  for (let i = 1; i <= steps; i++) {
    const nx = cur.x + (x - cur.x) * (i / steps), ny = cur.y + (y - cur.y) * (i / steps);
    await page.evaluate((a, b) => window.__gd.cur(a, b), nx, ny);
    await page.mouse.move(nx, ny);
    await sleep(14);
  }
  moveTo._last = { x, y };
}
async function clickAt(x, y) {
  await moveTo(x, y);
  await page.evaluate(() => window.__gd.click());
  await page.mouse.click(x, y);
  await sleep(500);
}

// ============ 実演 ============
console.log('録画中…');

await step('1 / 9　開いたときに出るもの');
await cap('点群ビューアを開いたところです', 'ソフトのインストールは要りません。ブラウザだけで開きます');
await ring('.modal-box');
await cap('最初に、この PC で動くかを確認します', '3D が使えるか、GPU が効いているかをその場で判定します');
await cap('結果はコピーして送れます', '庁内の PC で 1 回開けば、動作環境の確認はこれで済みます');
await capture('01-起動時の動作確認', '起動時の動作確認');
await ring(null);
const okBtn = await page.$('.modal.show .btn.primary');
if (okBtn) { const b = await okBtn.boundingBox(); await clickAt(b.x + b.width / 2, b.y + b.height / 2); }
await sleep(3000);

await step('2 / 9　画面の見かた');
await ring('.title-block');
await cap('上に工事名・発注者・工期が出ます', 'どの工事のデータかが一目で分かります');
await ring('.badge');
await cap('右上が判定結果です', '規格値を満たしていれば「合格」と出ます');
await ring(null);
await capture('02-画面全体', '画面全体');

await step('3 / 9　平面図と色の見かた');
await cap('最初に開くのは平面図です', '見慣れた真上からの図から始まります');
await cap('色は設計面との差を表します', '赤＝設計より高い（盛り気味）／青＝設計より低い（削り気味）');
await ring('.legend');
await cap('凡例はここにあります', '±50mm の範囲を色で表しています');
await ring(null);
await capture('03-較差カラーマップ', '較差のカラーマップ');

await step('4 / 9　動かしかた');
await ring('#controls-hint');
await cap('操作方法は画面の左上に出しています', '迷ったらここを見てください');
await ring(null);
await cap('ドラッグで動かします', '地図と同じ感覚です');
await moveTo(420, 430);
await page.mouse.down();
for (let i = 0; i < 20; i++) {
  const x = 420 + i * 7, y = 430 + Math.sin(i / 7) * 14;
  await page.mouse.move(x, y);
  await page.evaluate((a, b) => window.__gd.cur(a, b), x, y);
  await sleep(30);
}
await page.mouse.up();
await sleep(900);
await cap('ホイールで拡大・縮小できます', '気になる箇所に寄って見られます');
await moveTo(430, 470);
for (let i = 0; i < 7; i++) { await page.mouse.wheel({ deltaY: -230 }); await sleep(170); }
await sleep(1500);
await capture('04-拡大', '拡大したところ');
for (let i = 0; i < 7; i++) { await page.mouse.wheel({ deltaY: 230 }); await sleep(150); }
await sleep(1300);

await step('5 / 9　色の範囲を変える');
const slider = await page.$('.slider-row input[type=range]');
if (slider) {
  const b = await slider.boundingBox();
  await ring('.slider-row');
  await cap('色の範囲は変えられます', '狭くすると小さな差も見えるようになります');
  await moveTo(b.x + b.width * 0.16, b.y + b.height / 2);
  await page.evaluate(() => window.__gd.click());
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    const x = Math.max(b.x + 1, b.x + b.width * (0.16 - i * 0.011));
    await page.mouse.move(x, b.y + b.height / 2);
    await page.evaluate((a, c) => window.__gd.cur(a, c), x, b.y + b.height / 2);
    await sleep(85);
  }
  await page.mouse.up();
  await sleep(1700);
  await capture('05-色域を狭める', '色の範囲を狭めたところ');
  await ring(null);
}

await step('6 / 9　規格値の判定');
await ring('.panel:first-child');
await cap('判定は出来形管理要領の様式に沿って出ます', '天端と法面を分けて、部位ごとに判定します');
await sleep(1400);
await capture('06-規格値判定', '規格値判定（様式-31-2）');
await ring(null);

await step('7 / 9　3D で見る');
await cap('3D で見ることもできます', '上のタブで切り替えます');
const tab3d = await page.$('.tab[data-view="3d"]');
const b3d = await tab3d.boundingBox();
await clickAt(b3d.x + b3d.width / 2, b3d.y + b3d.height / 2);
await sleep(5400);
await ring('#controls-hint');
await cap('3D では左ドラッグで回転します', '操作方法は左上に出ています');
await ring(null);
await moveTo(480, 430);
await page.mouse.down();
for (let i = 0; i < 34; i++) {
  const x = 480 + Math.sin(i / 11) * 150, y = 430 - Math.sin(i / 17) * 30;
  await page.mouse.move(x, y);
  await page.evaluate((a, c) => window.__gd.cur(a, c), x, y);
  await sleep(45);
}
await page.mouse.up();
await sleep(1700);
await capture('07-3D表示', '3D 表示');
await cap('既定では地表面だけを表示しています', '判定に使っているのと同じ範囲です。外すと草木も出ます');

await step('8 / 9　断面をつくる');
const tabSec = await page.$('.tab[data-view="section"]');
const bs = await tabSec.boundingBox();
await cap('断面図も作れます', '「断面」タブを押します');
await clickAt(bs.x + bs.width / 2, bs.y + bs.height / 2);
await sleep(2800);
await cap('平面図の上で 2 点をクリックします', '画面の指示どおりに ① 始点 → ② 終点 の順で押します');
await clickAt(250, 430);
await sleep(1500);
await clickAt(820, 430);
await sleep(4400);
await cap('縦断図ができました', '赤い破線が設計面、点が実測です。ずれが目で見て分かります');
await sleep(1700);
await capture('08-断面図', '断面図');
await ring('.view-hint');
await cap('引き直すときは、そのまま平面図をクリックするだけです', '「測線を引き直す」ボタンからでもできます');
await ring(null);
await clickAt(300, 330);
await sleep(1300);
await clickAt(760, 520);
await sleep(4000);
await capture('09-断面図（引き直し）', '測線を引き直したところ');

await step('9 / 9　帳票と自分のデータ');
for (const p of await page.$$('.panel-head')) {
  const t = await p.evaluate((e) => e.textContent);
  if (t.includes('帳票')) {
    const bb = await p.boundingBox();
    await cap('判定結果は CSV で出せます', 'Excel でそのまま開けます');
    await clickAt(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(2000);
    await capture('10-帳票', '帳票の出力');
    break;
  }
}
const openBtn = await page.$('#open-data-btn');
if (openBtn) {
  const bb = await openBtn.boundingBox();
  await ring('#open-data-btn');
  await cap('自分のデータを読み込むこともできます', '右上の「データを開く」から');
  await ring(null);
  await clickAt(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await sleep(2200);
  await cap('点群と設計データを放り込むだけです', '変換用のソフトは要りません。その場で較差と判定を出します');
  await capture('11-データを開く', 'データの取り込み画面');
  await sleep(1400);
  const cl = await page.$('.imp-close');
  if (cl) { const cb = await cl.boundingBox(); await clickAt(cb.x + cb.width / 2, cb.y + cb.height / 2); }
  await sleep(1200);
}
await page.evaluate(() => window.__gd.cur(0, 0, false));
await step('');
await cap('WebGL が使えない PC でも、平面図・断面図・帳票は見られます', '3D だけを諦めて 2D 表示に自動で切り替わります', 4200);
await cap('', '', 900);

await client.send('Page.stopScreencast');
await browser.close();
server.close();
console.log(`フレーム数: ${frame}`);

// --- ffmpeg で動画に ---
// 実時刻の差をそのままフレームの表示時間にする（= 実時間どおりの尺になる）
frames.sort((a, b) => a.t - b.t);
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const d = i < frames.length - 1
    ? Math.min(1.0, Math.max(1 / 60, frames[i + 1].t - frames[i].t))
    : 0.4;
  lines.push(`file '${frames[i].file}'`, `duration ${d.toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`);
const listFile = join(framesDir, 'list.txt');
await writeFile(listFile, lines.join('\n'));

const mp4 = join(outDir, '使い方.mp4');
await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-movflags', '+faststart', mp4]);

// GIF は README 用の短い抜粋（断面を作るところ）。全編を GIF にすると大きすぎる。
const gif = join(outDir, '使い方-抜粋.gif');
const pal = join(framesDir, 'palette.png');
const GIF_START = process.env.GIF_START ?? '58';
const GIF_LEN = process.env.GIF_LEN ?? '16';
await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', GIF_START, '-t', GIF_LEN, '-i', mp4,
  '-vf', 'fps=9,scale=640:-1:flags=lanczos,palettegen=stats_mode=diff', pal]);
await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', GIF_START, '-t', GIF_LEN, '-i', mp4, '-i', pal,
  '-lavfi', 'fps=9,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4', gif]);

const dur = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]);
await writeFile(join(outDir, 'captures.json'), JSON.stringify(captures, null, 2));
await rm(framesDir, { recursive: true, force: true });

const sz = async (f) => `${((await stat(f)).size / 1048576).toFixed(1)} MB`;
console.log(`\n動画:   ${mp4}  ${await sz(mp4)}  ${Number(dur.stdout).toFixed(1)} 秒`);
console.log(`GIF:    ${gif}  ${await sz(gif)}`);
console.log(`キャプチャ: ${captures.length} 枚`);
