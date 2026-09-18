/**
 * 画面の画素を実測するための共通処理。
 *
 * 【重要】WebGL のキャンバスをページ内で drawImage して読み出すと、
 * preserveDrawingBuffer を有効にしていない限り空の画像が返る。
 * 「点が描かれているか」をページ内の読み出しで判定すると、
 * 真っ黒な画像を見て合格してしまう。
 * 必ず page.screenshot（合成後の画面）を使うこと。
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** キャンバス領域を撮って、縮小した生 RGB として返す */
export async function grabCanvasRgb(page, { w = 160, h = 100 } = {}) {
  const el = await page.$('.canvas-host');
  if (!el) return null; // 起動できずエラー画面になっている場合など
  const png = await el.screenshot({ type: 'png' });
  const dir = await mkdtemp(join(tmpdir(), 'tengun-px-'));
  try {
    const src = join(dir, 'a.png'), dst = join(dir, 'a.raw');
    await writeFile(src, png);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
      '-vf', `scale=${w}:${h}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', dst]);
    return { data: await readFile(dst), w, h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 2 枚の差（0〜1）。0 なら完全に同じ。 */
export function frameDistance(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.data.length, b.data.length);
  let diff = 0;
  for (let i = 0; i < n; i++) diff += Math.abs(a.data[i] - b.data[i]);
  return diff / (n * 255);
}

/** 背景色（既定の淡いグレー）以外の画素の割合と、色の多様さ */
export function contentStats(frame, bg = [242, 244, 246]) {
  if (!frame) return { nonBgRatio: 0, distinctColors: 0, total: 0, missing: true };
  const d = frame.data;
  let nonBg = 0, total = 0;
  const seen = new Set();
  for (let i = 0; i + 2 < d.length; i += 3) {
    total++;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - bg[0]) > 8 || Math.abs(g - bg[1]) > 8 || Math.abs(b - bg[2]) > 8) nonBg++;
    seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  return { nonBgRatio: nonBg / total, distinctColors: seen.size, total };
}
