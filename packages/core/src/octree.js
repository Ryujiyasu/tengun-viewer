/**
 * LOD 用オクツリーの構築とバイナリ化。
 *
 * PotreeConverter 2.x と同じ考え方（ノードごとに間引いた点を持ち、
 * 残りを子ノードに渡す）だが、外部バイナリに依存しないよう自前で実装する。
 * 出力形式は docs/octree-format.md に記載。
 *
 * 【注意】座標は「ローカル原点からの相対値」を int32 量子化して格納する。
 *         平面直角座標系の生値（-155,500 など）を float32 で GPU に渡すと
 *         mm 単位の情報が丸め落ちして描画が壊れる。
 */

export const BYTES_PER_POINT = 28;
export const OCTREE_FORMAT = 'tengun-octree/1';

export const ATTRIBUTES = [
  { name: 'position', type: 'int32', size: 3, offset: 0, description: '(値 * scale + offset) でローカル座標(m)' },
  { name: 'rgb', type: 'uint8', size: 3, offset: 12 },
  { name: 'classification', type: 'uint8', size: 1, offset: 15 },
  { name: 'intensity', type: 'uint16', size: 1, offset: 16 },
  { name: 'flags', type: 'uint8', size: 1, offset: 18, description: 'bit0: deviation 有効 / bit1: deviationAlt 有効' },
  { name: 'reserved', type: 'uint8', size: 1, offset: 19 },
  { name: 'deviation', type: 'float32', size: 1, offset: 20, description: '判定に使う較差(m)。既定は標高較差。無効時 NaN' },
  { name: 'deviationAlt', type: 'float32', size: 1, offset: 24, description: '表示用の別方式の較差(m)。既定は法線方向較差。無効時 NaN' },
];

/**
 * @param {{count:number,e:Float64Array,n:Float64Array,h:Float64Array,rgb?:Uint8Array,
 *          intensity?:Uint16Array,classification?:Uint8Array,deviation?:Float32Array}} points
 * @param {{gridSize?:number,leafThreshold?:number,maxLevel?:number,scale?:number,
 *          origin?:number[], onProgress?:Function}} opts
 */
export function buildOctree(points, opts = {}) {
  const {
    gridSize = 128,
    leafThreshold = 20000,
    maxLevel = 12,
    scale = 0.001,
    onProgress,
  } = opts;

  const N = points.count;
  if (N === 0) throw new Error('点が 0 件です');

  // 実データの bbox
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < N; i++) {
    if (points.e[i] < minE) minE = points.e[i];
    if (points.e[i] > maxE) maxE = points.e[i];
    if (points.n[i] < minN) minN = points.n[i];
    if (points.n[i] > maxN) maxN = points.n[i];
    if (points.h[i] < minH) minH = points.h[i];
    if (points.h[i] > maxH) maxH = points.h[i];
  }

  // ローカル原点 = bbox の底面中心。GPU に渡す前の平行移動はここで効かせる。
  const origin = opts.origin ?? [(minE + maxE) / 2, (minN + maxN) / 2, minH];

  // 立方体にそろえる（オクツリーの分割が等方になる）
  const size = Math.max(maxE - minE, maxN - minN, maxH - minH) * 1.001 || 1;
  const cube = {
    min: [(minE + maxE) / 2 - size / 2, (minN + maxN) / 2 - size / 2, (minH + maxH) / 2 - size / 2],
    size,
  };

  const occupancy = new Uint8Array(gridSize * gridSize * gridSize);
  const touched = new Int32Array(gridSize * gridSize * gridSize);

  const nodes = [];
  let processed = 0;

  /** @param {Int32Array} indices */
  function build(name, indices, cmin, csize, level) {
    if (indices.length === 0) return;

    if (indices.length <= leafThreshold || level >= maxLevel) {
      nodes.push({ name, level, indices, min: cmin.slice(), size: csize });
      processed += indices.length;
      onProgress?.(processed, N);
      return;
    }

    const cell = csize / gridSize;
    const accepted = [];
    const rest = [];
    let nTouched = 0;

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      let ix = ((points.e[i] - cmin[0]) / cell) | 0;
      let iy = ((points.n[i] - cmin[1]) / cell) | 0;
      let iz = ((points.h[i] - cmin[2]) / cell) | 0;
      if (ix < 0) ix = 0; else if (ix >= gridSize) ix = gridSize - 1;
      if (iy < 0) iy = 0; else if (iy >= gridSize) iy = gridSize - 1;
      if (iz < 0) iz = 0; else if (iz >= gridSize) iz = gridSize - 1;
      const key = ix + iy * gridSize + iz * gridSize * gridSize;
      if (occupancy[key] === 0) {
        occupancy[key] = 1;
        touched[nTouched++] = key;
        accepted.push(i);
      } else {
        rest.push(i);
      }
    }
    for (let t = 0; t < nTouched; t++) occupancy[touched[t]] = 0;

    nodes.push({ name, level, indices: Int32Array.from(accepted), min: cmin.slice(), size: csize });
    processed += accepted.length;
    onProgress?.(processed, N);

    // 残りを 8 分割して子へ
    const half = csize / 2;
    const buckets = [[], [], [], [], [], [], [], []];
    for (let k = 0; k < rest.length; k++) {
      const i = rest[k];
      const bx = points.e[i] >= cmin[0] + half ? 1 : 0;
      const by = points.n[i] >= cmin[1] + half ? 1 : 0;
      const bz = points.h[i] >= cmin[2] + half ? 1 : 0;
      buckets[bx + by * 2 + bz * 4].push(i);
    }
    for (let b = 0; b < 8; b++) {
      if (buckets[b].length === 0) continue;
      const childMin = [
        cmin[0] + (b & 1 ? half : 0),
        cmin[1] + (b & 2 ? half : 0),
        cmin[2] + (b & 4 ? half : 0),
      ];
      build(name + b, Int32Array.from(buckets[b]), childMin, half, level + 1);
    }
  }

  const all = new Int32Array(N);
  for (let i = 0; i < N; i++) all[i] = i;
  build('r', all, cube.min, cube.size, 0);

  nodes.sort((a, b) => (a.level - b.level) || (a.name < b.name ? -1 : 1));

  return {
    nodes,
    cube,
    origin,
    scale,
    bounds: { minE, maxE, minN, maxN, minH, maxH },
    spacing: cube.size / gridSize,
    gridSize,
    pointCount: N,
  };
}

/** オクツリーを octree.bin + hierarchy に直列化する */
export function serializeOctree(tree, points) {
  const total = tree.nodes.reduce((s, nd) => s + nd.indices.length, 0);
  const bin = new Uint8Array(total * BYTES_PER_POINT);
  const dv = new DataView(bin.buffer);
  const [ox, oy, oz] = tree.origin;
  const s = tree.scale;

  const hierarchy = [];
  let cursor = 0;
  for (const nd of tree.nodes) {
    const byteOffset = cursor * BYTES_PER_POINT;
    let nmin = [Infinity, Infinity, Infinity], nmax = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < nd.indices.length; k++) {
      const i = nd.indices[k];
      const p = (cursor + k) * BYTES_PER_POINT;
      const le = points.e[i] - ox, ln = points.n[i] - oy, lh = points.h[i] - oz;
      dv.setInt32(p, Math.round(le / s), true);
      dv.setInt32(p + 4, Math.round(ln / s), true);
      dv.setInt32(p + 8, Math.round(lh / s), true);
      if (points.rgb) {
        bin[p + 12] = points.rgb[i * 3];
        bin[p + 13] = points.rgb[i * 3 + 1];
        bin[p + 14] = points.rgb[i * 3 + 2];
      } else {
        bin[p + 12] = bin[p + 13] = bin[p + 14] = 200;
      }
      bin[p + 15] = points.classification ? points.classification[i] : 0;
      dv.setUint16(p + 16, points.intensity ? points.intensity[i] : 0, true);
      const dev = points.deviation ? points.deviation[i] : NaN;
      const dev2 = points.deviationAlt ? points.deviationAlt[i] : NaN;
      bin[p + 18] = (Number.isNaN(dev) ? 0 : 1) | (Number.isNaN(dev2) ? 0 : 2);
      bin[p + 19] = 0;
      dv.setFloat32(p + 20, dev, true);
      dv.setFloat32(p + 24, dev2, true);

      if (le < nmin[0]) nmin[0] = le; if (le > nmax[0]) nmax[0] = le;
      if (ln < nmin[1]) nmin[1] = ln; if (ln > nmax[1]) nmax[1] = ln;
      if (lh < nmin[2]) nmin[2] = lh; if (lh > nmax[2]) nmax[2] = lh;
    }
    hierarchy.push({
      name: nd.name,
      level: nd.level,
      pointCount: nd.indices.length,
      byteOffset,
      byteSize: nd.indices.length * BYTES_PER_POINT,
      // ノードの担当空間（LOD 判定用）とローカル bbox（描画用）
      cube: [nd.min[0] - ox, nd.min[1] - oy, nd.min[2] - oz, nd.size],
      min: nmin, max: nmax,
    });
    cursor += nd.indices.length;
  }

  return {
    bin,
    hierarchy: {
      format: OCTREE_FORMAT,
      bytesPerPoint: BYTES_PER_POINT,
      attributes: ATTRIBUTES,
      pointCount: total,
      spacing: tree.spacing,
      gridSize: tree.gridSize,
      scale: [tree.scale, tree.scale, tree.scale],
      // ローカル座標 → 平面直角座標 は  world = local + origin
      origin: tree.origin,
      cube: { min: tree.cube.min.map((v, i) => v - tree.origin[i]), size: tree.cube.size },
      boundsWorld: tree.bounds,
      nodes: hierarchy,
    },
  };
}
