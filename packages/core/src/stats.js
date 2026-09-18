/**
 * 較差の統計量とヒストグラム。判定と帳票の入力になる。
 * 単位は内部では m、表示・帳票では mm。取り違えないよう関数名に付ける。
 */

/** @param {Float32Array} dev 法線方向較差（m）。NaN は設計面範囲外として除外。 */
export function deviationStats(dev, { withinToleranceM = 0.05 } = {}) {
  let n = 0, sum = 0, min = Infinity, max = -Infinity, sumSq = 0, within = 0;
  for (let i = 0; i < dev.length; i++) {
    const v = dev[i];
    if (Number.isNaN(v)) continue;
    n++; sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (Math.abs(v) <= withinToleranceM) within++;
  }
  if (n === 0) {
    return { count: 0, mean: NaN, stddev: NaN, min: NaN, max: NaN, rms: NaN, withinRatio: NaN, median: NaN, p95: NaN };
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const sorted = percentiles(dev, [0.5, 0.95]);
  return {
    count: n,
    mean,
    stddev: Math.sqrt(variance),
    min, max,
    rms: Math.sqrt(sumSq / n),
    withinRatio: within / n,
    median: sorted[0],
    p95: sorted[1],
    maxAbs: Math.max(Math.abs(min), Math.abs(max)),
  };
}

function percentiles(dev, ps) {
  const vals = [];
  for (let i = 0; i < dev.length; i++) if (!Number.isNaN(dev[i])) vals.push(dev[i]);
  vals.sort((a, b) => a - b);
  if (!vals.length) return ps.map(() => NaN);
  return ps.map((p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]);
}

/** ヒストグラム。range は m 単位の [min,max]。 */
export function histogram(dev, { bins = 61, range = [-0.05, 0.05] } = {}) {
  const [lo, hi] = range;
  const counts = new Int32Array(bins);
  let under = 0, over = 0, nan = 0;
  for (let i = 0; i < dev.length; i++) {
    const v = dev[i];
    if (Number.isNaN(v)) { nan++; continue; }
    if (v < lo) { under++; continue; }
    if (v > hi) { over++; continue; }
    const b = Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins));
    counts[b]++;
  }
  return { bins, range: [lo, hi], counts, under, over, nan, binWidth: (hi - lo) / bins };
}
