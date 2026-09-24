#!/usr/bin/env node
/**
 * ビューアの動作検証。
 * 「ビルドが通った」ではなく「実際に点が描かれた」ところまで確認する。
 *   - full 版を HTTP で配信して開く（方式 C 相当）
 *   - light 版を file:// で直接開く（方式 A 相当）
 *   - WebGL2 を無効化した場合のエラーメッセージ
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { findChrome, chromeArgs } from './lib/chrome.mjs';
import { grabCanvasRgb, contentStats } from './lib/pixels.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml',
};

/** Range 対応の静的サーバ（庁内 Web サーバ配置を模す） */
function serve(rootDir) {
  return new Promise((res) => {
    const server = createServer(async (req, rep) => {
      try {
        const url = decodeURIComponent(req.url.split('?')[0]);
        const path = join(rootDir, url === '/' ? 'index.html' : url);
        const st = await stat(path);
        const type = MIME[extname(path)] ?? 'application/octet-stream';
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : st.size - 1;
          const buf = await readFile(path);
          rep.writeHead(206, {
            'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
          });
          rep.end(buf.subarray(start, end + 1));
          return;
        }
        rep.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
        rep.end(await readFile(path));
      } catch {
        rep.writeHead(404); rep.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

const outBase = process.argv[2] ?? 'dist/sample';
const shotDir = process.argv[3] ?? 'docs/screenshots';
await mkdir(shotDir, { recursive: true });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  — ${detail}` : ''}`);
}

// 検証には PC にインストール済みの Chrome をそのまま使う（対象ブラウザの実物で確かめる）
const executablePath = findChrome();
console.log(`検証ブラウザ: ${executablePath}`);

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath,
  args: chromeArgs(['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--allow-file-access-from-files']),
});

async function openPage(url, { shot, label, disableGl = false }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else logs.push(m.text()); });
  if (disableGl) {
    await page.evaluateOnNewDocument(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (type === 'webgl2') return null;
        return orig.call(this, type, ...rest);
      };
    });
  }
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  // 起動時の動作確認ダイアログ。内容を控えてから閉じる。
  const env = await page.evaluate(() => {
    const m = document.querySelector('.modal.show');
    if (!m) return null;
    return {
      mark: m.querySelector('.env-mark')?.textContent ?? '',
      title: m.querySelector('.env-head h2')?.textContent ?? '',
      rows: m.querySelectorAll('.env-kv dt').length,
    };
  });
  await page.evaluate(() => document.querySelector('.modal.show .btn.primary')?.click());
  await new Promise((r) => setTimeout(r, 4500));
  const info = await page.evaluate(() => {
    const status = document.getElementById('status')?.textContent ?? '';
    const badge = document.querySelector('.badge')?.textContent ?? '';
    const title = document.querySelector('.project-name')?.textContent ?? '';
    const bootErr = document.querySelector('.boot-error h1')?.textContent ?? '';
    const canvas = document.querySelector('.canvas-host canvas');
    // 【注意】ここで canvas を drawImage して読むと、WebGL は preserveDrawingBuffer が
    // 無いので空の画像が返る。描画の確認は Node 側でスクリーンショットから行う。
    // 警告バナーがキャンバスを覆い隠していないかを幾何的に見る。
    // 「キャンバスに点が描かれている」だけでは、上に不透明な箱が乗っていても合格してしまう。
    let coverRatio = 0;
    const host = document.querySelector('.canvas-host');
    const warn = document.querySelector('.gl-warning');
    if (host && warn) {
      const hr = host.getBoundingClientRect(), wr = warn.getBoundingClientRect();
      const ov = Math.max(0, Math.min(hr.bottom, wr.bottom) - Math.max(hr.top, wr.top))
               * Math.max(0, Math.min(hr.right, wr.right) - Math.max(hr.left, wr.left));
      coverRatio = ov / Math.max(1, hr.width * hr.height);
    }
    const scalebarShown = !!document.querySelector('#scalebar.show');
    const northShown = !!document.querySelector('#north.show');

    return {
      status, badge, title, bootErr, coverRatio, scalebarShown, northShown,
      controlsHint: document.getElementById('controls-hint')?.textContent ?? '',
      hasOpenDataBtn: !!document.getElementById('open-data-btn'),
      brandLogo: !!document.querySelector('.brand-logo svg'),
      hasCanvas: !!canvas,
      canvasSize: canvas ? [canvas.width, canvas.height] : null,

      panels: [...document.querySelectorAll('.panel-head')].map((p) => p.textContent),
      judgeRows: document.querySelectorAll('.judge-table tbody tr').length,
      histSvg: !!document.querySelector('.hist-host svg rect'),
    };
  });
  if (shot) await page.screenshot({ path: join(shotDir, shot), fullPage: false });
  // 合成後の画面から実測する
  const px = contentStats(await grabCanvasRgb(page, { w: 220, h: 140 }));
  return { page, info: { ...info, px, env }, errors, logs };
}

// ---- 1. full 版を HTTP で ----
const fullDir = resolve(outBase, 'full');
const { server, port } = await serve(fullDir);
console.log(`\n== フル版 (HTTP, Range 対応) http://127.0.0.1:${port}/ ==`);
{
  const { page, info, errors } = await openPage(`http://127.0.0.1:${port}/`, { shot: 'full-plan.png' });
  record('フル版が起動する', !info.bootErr, info.bootErr || info.title);
  record('キャンバスに点が描画されている',
    info.px.nonBgRatio > 0.05 && info.px.distinctColors > 12,
    `背景以外 ${(info.px.nonBgRatio * 100).toFixed(1)}% / 色数 ${info.px.distinctColors}`);
  record('判定パネルが出ている', info.judgeRows >= 1, `${info.judgeRows} 行 / ${info.badge}`);
  record('ヒストグラムが描かれている', info.histSvg);
  record('平面図にスケールバーが出ている', info.scalebarShown);
  record('平面図に方位記号が出ている', info.northShown);
  record('起動時に動作確認が出る', !!info.env && /[○△×]/.test(info.env.mark),
    info.env ? `${info.env.mark} ${info.env.title} / 詳細 ${info.env.rows} 項目` : '(出なかった)');
  record('操作方法が画面に出ている', /ドラッグ/.test(info.controlsHint), info.controlsHint.slice(0, 40));
  record('「データを開く」ボタンがある', info.hasOpenDataBtn);
  record('ロゴが表示されている', info.brandLogo);
  record('JS エラーがない', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`   ステータス: ${info.status.trim()}`);

  // 3D に切り替え
  await page.click('.tab[data-view="3d"]');
  await new Promise((r) => setTimeout(r, 4000));
  const three = contentStats(await grabCanvasRgb(page, { w: 220, h: 140 }));
  await page.screenshot({ path: join(shotDir, 'full-3d.png') });
  record('3D 表示に切り替わる', three.nonBgRatio > 0.03 && three.distinctColors > 12,
    `背景以外 ${(three.nonBgRatio * 100).toFixed(1)}% / 色数 ${three.distinctColors}`);

  // 断面
  await page.click('.tab[data-view="section"]');
  await new Promise((r) => setTimeout(r, 1500));
  const box = await page.$eval('.canvas-host', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.25, box.y + box.h * 0.5);
  await new Promise((r) => setTimeout(r, 400));
  await page.mouse.click(box.x + box.w * 0.75, box.y + box.h * 0.5);
  await new Promise((r) => setTimeout(r, 2500));
  const sec = await page.evaluate(() => ({
    head: document.querySelector('.section-head span')?.textContent ?? '',
    circles: document.querySelectorAll('.section-svg svg circle').length,
    path: document.querySelectorAll('.section-svg svg path').length,
  }));
  await page.screenshot({ path: join(shotDir, 'full-section.png') });
  record('断面図が生成される', sec.circles > 50, `${sec.head} / 実測点 ${sec.circles} / 設計線 ${sec.path}`);
  await page.close();
}

// ---- 2. WebGL2 無効時 ----
console.log('\n== WebGL2 無効時 ==');
{
  const { page, info, errors } = await openPage(`http://127.0.0.1:${port}/`, { shot: 'no-webgl2.png', disableGl: true });
  record('日本語のエラーメッセージが出る', /WebGL2|ブラウザ/.test(info.bootErr), info.bootErr);
  record('2D モードに落ちて点が描かれる',
    info.px.nonBgRatio > 0.03 && info.px.distinctColors > 10,
    `背景以外 ${(info.px.nonBgRatio * 100).toFixed(1)}% / 色数 ${info.px.distinctColors}`);
  record('警告が点群を覆い隠していない', info.coverRatio < 0.5,
    `キャンバスの ${(info.coverRatio * 100).toFixed(0)}% を占有`);
  record('2D モードでもスケールバーが出る', info.scalebarShown);
  record('判定・帳票は見られる', info.judgeRows >= 1, `判定 ${info.judgeRows} 行`);
  record('致命的な JS エラーがない', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}
server.close();

// ---- 3. light 版を file:// で ----
console.log('\n== 軽量版 (file://) ==');
{
  const lightFile = resolve(outBase, 'light', 'index.html');
  const { page, info, errors } = await openPage(`file://${lightFile}`, { shot: 'light-file.png' });
  record('file:// で起動する', !info.bootErr, info.bootErr || info.title);
  record('点が描画されている', info.px.nonBgRatio > 0.05 && info.px.distinctColors > 12,
    `背景以外 ${(info.px.nonBgRatio * 100).toFixed(1)}% / 色数 ${info.px.distinctColors}`);
  record('判定が出ている', info.judgeRows >= 1, info.badge);
  record('JS エラーがない', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`   ステータス: ${info.status.trim()}`);
  await page.close();
}

// ---- 4. フル版を file:// で開いた場合の案内 ----
console.log('\n== フル版を file:// で開いた場合 ==');
{
  const fullFile = resolve(outBase, 'full', 'index.html');
  const { page, info } = await openPage(`file://${fullFile}`, { shot: 'full-file-warning.png' });
  record('file:// では開けない旨を日本語で案内する', /file:\/\//.test(info.bootErr), info.bootErr);
  await page.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 件 合格`);
await writeFile(join(shotDir, 'verify-result.json'), JSON.stringify(results, null, 2));
if (failed.length) { console.log('失敗:'); for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`); process.exit(1); }
