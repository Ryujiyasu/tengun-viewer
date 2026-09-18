/**
 * 点群と設計面 TIN の法線方向較差を一括計算する。
 */
import { TinSurface } from './tin.js';

/**
 * @param {{count:number,e:Float64Array,n:Float64Array,h:Float64Array}} points
 * @param {TinSurface} tin
 * @param {{maxDistance?:number, onProgress?:(done:number,total:number)=>void}} opts
 * @returns {{deviation:Float32Array, inRange:number, outOfRange:number}}
 *          設計面の範囲外の点は NaN（着色しない・判定に含めない）
 */
export function computeDeviations(points, tin, { maxDistance = 5, onProgress } = {}) {
  const n = points.count;
  const dev = new Float32Array(n);
  let inRange = 0, outOfRange = 0;
  const chunk = Math.max(1, Math.floor(n / 100));

  // deviationAt() は割り当てゼロ。ここで closest() を使うと GC が効いて数倍遅くなる。
  const pe = points.e, pn = points.n, ph = points.h;
  for (let i = 0; i < n; i++) {
    const d = tin.deviationAt(pe[i], pn[i], ph[i], maxDistance);
    dev[i] = d;
    if (Number.isNaN(d)) outOfRange++; else inRange++;
    if (onProgress && (i % chunk === 0 || i === n - 1)) onProgress(i + 1, n);
  }
  return { deviation: dev, inRange, outOfRange };
}

/**
 * 2 時期の点群同士の差分（P3 のり面カルテ向け）。
 * 後期点群を TIN 化せず、前期点群を格子化した DSM と比較する簡易版。
 */
export function gridDifference(before, after, cellSize = 0.5) {
  const b = rasterize(before, cellSize);
  const a = rasterize(after, cellSize, b);
  const diff = new Float32Array(b.w * b.h);
  let valid = 0;
  for (let i = 0; i < diff.length; i++) {
    if (b.count[i] === 0 || a.count[i] === 0) { diff[i] = NaN; continue; }
    diff[i] = a.z[i] - b.z[i];
    valid++;
  }
  return { ...b, diff, valid };
}

function rasterize(p, cellSize, like = null) {
  const minE = like ? like.minE : Math.min(...sample(p.e, p.count));
  const minN = like ? like.minN : Math.min(...sample(p.n, p.count));
  const maxE = like ? like.minE + like.w * cellSize : Math.max(...sample(p.e, p.count));
  const maxN = like ? like.minN + like.h * cellSize : Math.max(...sample(p.n, p.count));
  const w = like ? like.w : Math.max(1, Math.ceil((maxE - minE) / cellSize));
  const h = like ? like.h : Math.max(1, Math.ceil((maxN - minN) / cellSize));
  const z = new Float64Array(w * h);
  const count = new Int32Array(w * h);
  for (let i = 0; i < p.count; i++) {
    const c = Math.floor((p.e[i] - minE) / cellSize);
    const r = Math.floor((p.n[i] - minN) / cellSize);
    if (c < 0 || c >= w || r < 0 || r >= h) continue;
    const k = r * w + c;
    z[k] += p.h[i]; count[k]++;
  }
  for (let k = 0; k < z.length; k++) if (count[k]) z[k] /= count[k];
  return { minE, minN, w, h, cellSize, z, count };
}

function sample(arr, n) {
  const step = Math.max(1, Math.floor(n / 10000));
  const out = [];
  for (let i = 0; i < n; i += step) out.push(arr[i]);
  return out;
}
