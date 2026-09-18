/**
 * 較差の算出方式。
 *
 * 出典: 国土交通省「３次元計測技術を用いた出来形管理要領（案）令和８年３月版」
 *       別紙１ 実施事項 第１編 面管理編 第５章「出来形管理資料作成」
 *
 * 要領は土工について次の 2 つを定めている。
 *   標高較差 … 各ポイントの標高値と、平面座標が同じ設計面上の設計標高値との差分
 *   水平較差 … 当該ポイントを含み「法面等の位置をコントロールする線形」に直交する
 *              平面上で、当該ポイントと同一標高の設計横断上の点との距離
 *
 * 「法線方向較差」は要領には無い。ただし傾斜面の施工誤差を直感的に表すため、
 * 表示用の第 3 の方式として用意する。判定に使うと検査職員が見る数字と合わなくなるので、
 * 既定の判定方式は標高較差とすること。
 */

export const MEASURES = {
  elevation: {
    id: 'elevation',
    name: '標高較差',
    unit: 'm',
    official: true,
    description: '点の標高と、同じ平面座標の設計面標高との差。要領が土工で定める方式。',
    sign: '正 = 設計面より高い / 負 = 設計面より低い',
  },
  horizontal: {
    id: 'horizontal',
    name: '水平較差',
    unit: 'm',
    official: true,
    description: '同一標高の設計横断上の点までの水平距離。法面で標高較差の代わりに使う。',
    sign: '正 = 設計面より外側 / 負 = 設計面より内側',
  },
  normal: {
    id: 'normal',
    name: '法線方向較差',
    unit: 'm',
    official: false,
    description: '設計面までの最短距離（法線方向）。要領には無い。傾斜面の施工誤差の把握用。',
    sign: '正 = 設計面より法線側 / 負 = 設計面より内側',
  },
};

/**
 * 標高較差を一括計算する。
 * 設計面の真下／真上に無い点（平面的に設計面の外）は NaN。
 */
export function computeElevationDeviations(points, tin, { onProgress } = {}) {
  const n = points.count;
  const dev = new Float32Array(n);
  let inRange = 0, outOfRange = 0;
  const chunk = Math.max(1, Math.floor(n / 100));
  const pe = points.e, pn = points.n, ph = points.h;
  for (let i = 0; i < n; i++) {
    const designH = tin.elevationAt(pe[i], pn[i]);
    if (Number.isNaN(designH)) { dev[i] = NaN; outOfRange++; }
    else { dev[i] = ph[i] - designH; inRange++; }
    if (onProgress && (i % chunk === 0 || i === n - 1)) onProgress(i + 1, n);
  }
  return { deviation: dev, inRange, outOfRange };
}

/**
 * 水平較差を一括計算する。
 *
 * 中心線形が与えられた場合はそれに直交する断面で、無い場合は
 * その点に最も近い設計三角形の最急勾配方向（＝横断方向）で断面を取る。
 * 断面上で、点と同じ標高になる設計面上の位置までの水平距離を返す。
 *
 * @param alignment [{e,n}, ...] 位置をコントロールする線形（道路中心・法肩など）。null 可。
 */
export function computeHorizontalDeviations(points, tin, { alignment = null, onProgress, maxDistance = 20 } = {}) {
  const n = points.count;
  const dev = new Float32Array(n);
  let inRange = 0, outOfRange = 0;
  const chunk = Math.max(1, Math.floor(n / 100));

  for (let i = 0; i < n; i++) {
    const e = points.e[i], nn = points.n[i], h = points.h[i];
    const dir = alignment ? crossDirectionFromAlignment(alignment, e, nn) : crossDirectionFromTin(tin, e, nn);
    if (!dir) { dev[i] = NaN; outOfRange++; continue; }

    const d = horizontalOffsetAtElevation(tin, e, nn, h, dir, maxDistance);
    if (Number.isNaN(d)) { dev[i] = NaN; outOfRange++; }
    else { dev[i] = d; inRange++; }
    if (onProgress && (i % chunk === 0 || i === n - 1)) onProgress(i + 1, n);
  }
  return { deviation: dev, inRange, outOfRange };
}

/** 線形に直交する向き（単位ベクトル） */
function crossDirectionFromAlignment(alignment, e, n) {
  let best = Infinity, ux = 0, uy = 0;
  for (let i = 0; i < alignment.length - 1; i++) {
    const a = alignment[i], b = alignment[i + 1];
    const dx = b.e - a.e, dy = b.n - a.n;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) continue;
    let t = ((e - a.e) * dx + (n - a.n) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.e + dx * t, py = a.n + dy * t;
    const d2 = (e - px) ** 2 + (n - py) ** 2;
    if (d2 < best) { best = d2; const L = Math.sqrt(len2); ux = -dy / L; uy = dx / L; }
  }
  return best === Infinity ? null : { x: ux, y: uy };
}

/** 最近傍三角形の最急勾配方向（水平成分）＝横断方向 */
function crossDirectionFromTin(tin, e, n) {
  const g = tin.grid;
  const k = tin._row(n) * g.cols + tin._col(e);
  for (let s = g.start[k]; s < g.start[k + 1]; s++) {
    const ti = g.items[s];
    const nx = tin.nx[ti], ny = tin.ny[ti];
    const len = Math.hypot(nx, ny);
    if (len > 1e-6) return { x: nx / len, y: ny / len };
  }
  return null;
}

/**
 * 断面上で、点と同じ標高になる設計面上の位置までの水平距離。
 * 断面に沿って設計面標高を走査し、点の標高と交差する位置を線形補間で求める。
 */
function horizontalOffsetAtElevation(tin, e, n, h, dir, maxDistance) {
  const step = 0.05;
  let prevOff = 0;
  let prevDiff = tin.elevationAt(e, n);
  if (Number.isNaN(prevDiff)) return NaN;
  prevDiff -= h;
  if (Math.abs(prevDiff) < 1e-9) return 0;

  // 設計面が点より高い側／低い側のどちらへ進めば交差するかを見て、両方向を試す
  for (const sgn of [1, -1]) {
    let po = 0, pd = prevDiff;
    for (let off = step; off <= maxDistance; off += step) {
      const de = tin.elevationAt(e + dir.x * off * sgn, n + dir.y * off * sgn);
      if (Number.isNaN(de)) break;
      const d = de - h;
      if ((pd <= 0 && d >= 0) || (pd >= 0 && d <= 0)) {
        const t = Math.abs(pd) / Math.max(1e-12, Math.abs(pd) + Math.abs(d));
        const hit = po + (off - po) * t;
        // 符号: 設計面より外側（法面が低くなる側に点がある）を正とする
        return hit * sgn * (prevDiff > 0 ? -1 : 1);
      }
      po = off; pd = d;
    }
  }
  return NaN;
}

/**
 * 設計 TIN の勾配で点を「天端（平場）」と「法面」に振り分ける。
 * 要領の出来形合否判定総括表は部位ごとに規格値が異なるため、部位分けが要る。
 * @param slopeThresholdDeg これより急な三角形の上の点を法面とする
 */
export function classifyParts(points, tin, { slopeThresholdDeg = 15 } = {}) {
  const n = points.count;
  const part = new Uint8Array(n); // 0=判定外, 1=天端(平場), 2=法面
  const counts = { none: 0, crest: 0, slope: 0 };
  for (let i = 0; i < n; i++) {
    const ti = nearestTriangleXY(tin, points.e[i], points.n[i]);
    if (ti < 0) { part[i] = 0; counts.none++; continue; }
    if (tin.slopeDeg(ti) >= slopeThresholdDeg) { part[i] = 2; counts.slope++; }
    else { part[i] = 1; counts.crest++; }
  }
  return { part, counts, slopeThresholdDeg };
}

function nearestTriangleXY(tin, e, n) {
  const g = tin.grid;
  const c = tin._col(e), r = tin._row(n);
  const k = r * g.cols + c;
  for (let s = g.start[k]; s < g.start[k + 1]; s++) {
    const ti = g.items[s];
    if (pointInTriangleXY(tin, ti, e, n)) return ti;
  }
  return -1;
}

function pointInTriangleXY(tin, ti, e, n) {
  const ia = tin.faces[ti * 3], ib = tin.faces[ti * 3 + 1], ic = tin.faces[ti * 3 + 2];
  const x1 = tin.e[ia], y1 = tin.n[ia], x2 = tin.e[ib], y2 = tin.n[ib], x3 = tin.e[ic], y3 = tin.n[ic];
  const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (det === 0) return false;
  const l1 = ((y2 - y3) * (e - x3) + (x3 - x2) * (n - y3)) / det;
  const l2 = ((y3 - y1) * (e - x3) + (x1 - x3) * (n - y3)) / det;
  const l3 = 1 - l1 - l2;
  const eps = -1e-9;
  return l1 >= eps && l2 >= eps && l3 >= eps;
}
