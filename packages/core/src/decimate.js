/**
 * light プロファイル（file:// で開く単一 HTML）用の間引き。
 *
 * 均等ランダムに間引くと、較差が大きい＝まさに見たい箇所が真っ先に消える。
 * ここでは
 *   1) XY 格子で全面のカバレッジを確保（各セルから最低 1 点）
 *   2) 残りの枠を、セルの平均 |較差| に比例して配分
 *   3) セル内では |較差| の大きい順に採用
 * という順で選ぶ。結果として全体の形は保たれ、当たり外れの大きい箇所は密に残る。
 */

export function decimateForLight(points, targetCount, { cellCountHint = 0.5 } = {}) {
  const N = points.count;
  if (N <= targetCount) {
    const idx = new Int32Array(N);
    for (let i = 0; i < N; i++) idx[i] = i;
    return { indices: idx, cells: 0, strategy: '間引きなし（目標点数以内）' };
  }

  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let i = 0; i < N; i++) {
    if (points.e[i] < minE) minE = points.e[i];
    if (points.e[i] > maxE) maxE = points.e[i];
    if (points.n[i] < minN) minN = points.n[i];
    if (points.n[i] > maxN) maxN = points.n[i];
  }
  const w = Math.max(maxE - minE, 1e-6), h = Math.max(maxN - minN, 1e-6);

  // セル数 ≒ 目標点数 * cellCountHint（残りを較差に応じて配る余地を残す）
  const wantCells = Math.max(1, Math.floor(targetCount * cellCountHint));
  const cell = Math.sqrt((w * h) / wantCells);
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const nCells = cols * rows;

  // CSR でセル → 点
  const counts = new Int32Array(nCells + 1);
  const cellOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const c = Math.min(cols - 1, Math.max(0, ((points.e[i] - minE) / w * cols) | 0));
    const r = Math.min(rows - 1, Math.max(0, ((points.n[i] - minN) / h * rows) | 0));
    const k = r * cols + c;
    cellOf[i] = k;
    counts[k + 1]++;
  }
  for (let k = 0; k < nCells; k++) counts[k + 1] += counts[k];
  const members = new Int32Array(N);
  const cursor = counts.slice(0, nCells);
  for (let i = 0; i < N; i++) members[cursor[cellOf[i]]++] = i;

  const dev = points.deviation;
  const absDev = (i) => {
    if (!dev) return 0;
    const v = dev[i];
    return Number.isNaN(v) ? 0 : Math.abs(v);
  };

  // セルごとの重み = 平均 |較差|（+ 下駄）。較差が無い場合は一様配分になる。
  const occupied = [];
  const weight = new Float64Array(nCells);
  let weightSum = 0;
  for (let k = 0; k < nCells; k++) {
    const lo = counts[k], hi = counts[k + 1];
    if (lo === hi) continue;
    occupied.push(k);
    let s = 0;
    for (let m = lo; m < hi; m++) s += absDev(members[m]);
    weight[k] = s / (hi - lo) + 1e-4;
    weightSum += weight[k];
  }

  const base = Math.min(targetCount, occupied.length); // カバレッジ用に 1 点ずつ
  let extra = targetCount - base;

  const quota = new Int32Array(nCells);
  for (const k of occupied) {
    const avail = counts[k + 1] - counts[k];
    let q = 1 + Math.floor((extra * weight[k]) / weightSum);
    quota[k] = Math.min(q, avail);
  }

  // 端数を較差の大きいセルから配る
  let used = 0;
  for (const k of occupied) used += quota[k];
  if (used < targetCount) {
    const order = occupied.slice().sort((a, b) => weight[b] - weight[a]);
    for (const k of order) {
      if (used >= targetCount) break;
      const avail = counts[k + 1] - counts[k];
      const add = Math.min(avail - quota[k], targetCount - used);
      quota[k] += add; used += add;
    }
  }

  const out = new Int32Array(Math.min(used, N));
  let w2 = 0;
  const scratch = [];
  for (const k of occupied) {
    const lo = counts[k], hi = counts[k + 1];
    const q = quota[k];
    if (q <= 0) continue;
    if (q >= hi - lo) {
      for (let m = lo; m < hi && w2 < out.length; m++) out[w2++] = members[m];
      continue;
    }
    scratch.length = 0;
    for (let m = lo; m < hi; m++) scratch.push(members[m]);
    scratch.sort((a, b) => absDev(b) - absDev(a));
    for (let j = 0; j < q && w2 < out.length; j++) out[w2++] = scratch[j];
  }

  return {
    indices: out.subarray(0, w2),
    cells: occupied.length,
    cellSizeM: Math.max(w / cols, h / rows),
    strategy: dev ? '較差優先（セル平均|較差|で配分）' : '一様（較差未計算のため）',
  };
}

/** 選んだ添字で SoA を絞り込む */
export function subsetPoints(points, indices) {
  const n = indices.length;
  const out = {
    count: n,
    e: new Float64Array(n), n: new Float64Array(n), h: new Float64Array(n),
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    rgb: points.rgb ? new Uint8Array(n * 3) : null,
    deviation: points.deviation ? new Float32Array(n) : null,
    deviationAlt: points.deviationAlt ? new Float32Array(n) : null,
  };
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    out.e[k] = points.e[i]; out.n[k] = points.n[i]; out.h[k] = points.h[i];
    if (points.intensity) out.intensity[k] = points.intensity[i];
    if (points.classification) out.classification[k] = points.classification[i];
    if (out.rgb) { out.rgb[k * 3] = points.rgb[i * 3]; out.rgb[k * 3 + 1] = points.rgb[i * 3 + 1]; out.rgb[k * 3 + 2] = points.rgb[i * 3 + 2]; }
    if (out.deviation) out.deviation[k] = points.deviation[i];
    if (out.deviationAlt) out.deviationAlt[k] = points.deviationAlt[i];
  }
  return out;
}
