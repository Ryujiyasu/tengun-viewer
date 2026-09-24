/**
 * 画面の画素を実測するための共通処理。
 *
 * 【重要】WebGL のキャンバスをページ内で drawImage して読み出すと、
 * preserveDrawingBuffer を有効にしていない限り空の画像が返る。
 * 「点が描かれているか」をページ内の読み出しで判定すると、
 * 真っ黒な画像を見て合格してしまう。必ず page.screenshot（合成後の画面）を使う。
 *
 * PNG の展開は node:zlib だけで行う。ここで ffmpeg を呼ぶと、動画を作らない
 * 環境（CI や ffmpeg の無い PC）で検証そのものが走らなくなる。
 */
import { inflateSync } from 'node:zlib';

/** puppeteer が返す PNG（8bit・非インターレース）を展開する */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG ではありません');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`対応していないビット深度: ${bitDepth}`);
  if (interlace !== 0) throw new Error('インターレース PNG は対応していません');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`対応していないカラータイプ: ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;                 // 8bit なので 1 画素 = channels バイト
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // スキャンラインのフィルタを戻す（PNG 仕様 9.2）
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`未知のフィルタ: ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }

  // RGB に揃える
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b;
    if (colorType === 3) {
      const idx = out[i] * 3;
      r = palette[idx]; g = palette[idx + 1]; b = palette[idx + 2];
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = out[i * channels];
    } else {
      r = out[i * channels]; g = out[i * channels + 1]; b = out[i * channels + 2];
    }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  return { width, height, data: rgb };
}

/** 最近傍で縮小する。比較用なので補間は要らない。 */
function downscale(src, w, h) {
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const s = (sy * src.width + sx) * 3, d = (y * w + x) * 3;
      out[d] = src.data[s]; out[d + 1] = src.data[s + 1]; out[d + 2] = src.data[s + 2];
    }
  }
  return { width: w, height: h, data: out };
}

/** キャンバス領域を撮って、縮小した生 RGB として返す */
export async function grabCanvasRgb(page, { w = 160, h = 100, selector = '.canvas-host' } = {}) {
  const el = await page.$(selector);
  if (!el) return null; // 起動できずエラー画面になっている場合など
  const png = await el.screenshot({ type: 'png' });
  return downscale(decodePng(Buffer.from(png)), w, h);
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
export function contentStats(frame, bg = [234, 238, 240]) {
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
