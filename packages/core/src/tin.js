/**
 * TIN サーフェスと、点から設計面への「法線方向較差」の計算。
 *
 * のり面のような傾斜面では鉛直較差は意味を持たないので、
 * 点から TIN 上の最近傍点までの距離を取り、三角形法線の向きで符号をつける。
 *   正 = 設計面より法線側（上側・外側） / 負 = 設計面より内側（削り込み側）
 *
 * 全計算は倍精度。float32 に落とすのは GPU に渡す直前だけ。
 */

export class TinSurface {
  /** @param {{e:Float64Array,n:Float64Array,h:Float64Array,faces:Int32Array,name?:string}} src */
  constructor(src) {
    this.name = src.name ?? 'surface';
    this.e = src.e; this.n = src.n; this.h = src.h;
    this.faces = src.faces;
    this.triCount = src.faces.length / 3;
    this._computeBounds();
    this._computeNormals();
    this._buildGrid();
  }

  _computeBounds() {
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < this.e.length; i++) {
      if (this.e[i] < minE) minE = this.e[i];
      if (this.e[i] > maxE) maxE = this.e[i];
      if (this.n[i] < minN) minN = this.n[i];
      if (this.n[i] > maxN) maxN = this.n[i];
      if (this.h[i] < minH) minH = this.h[i];
      if (this.h[i] > maxH) maxH = this.h[i];
    }
    this.bounds = { minE, maxE, minN, maxN, minH, maxH };
  }

  _computeNormals() {
    const t = this.triCount;
    const nx = new Float64Array(t), ny = new Float64Array(t), nz = new Float64Array(t);
    const area = new Float64Array(t);
    let flipped = 0;
    for (let i = 0; i < t; i++) {
      const a = this.faces[i * 3], b = this.faces[i * 3 + 1], c = this.faces[i * 3 + 2];
      const ux = this.e[b] - this.e[a], uy = this.n[b] - this.n[a], uz = this.h[b] - this.h[a];
      const vx = this.e[c] - this.e[a], vy = this.n[c] - this.n[a], vz = this.h[c] - this.h[a];
      let cx = uy * vz - uz * vy;
      let cy = uz * vx - ux * vz;
      let cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      area[i] = len / 2;
      if (len === 0) { nx[i] = 0; ny[i] = 0; nz[i] = 1; continue; }
      cx /= len; cy /= len; cz /= len;
      // 法線は上向き（nz>0）に揃える。これで「設計面より高い側が正」が定義できる。
      if (cz < 0) { cx = -cx; cy = -cy; cz = -cz; flipped++; }
      nx[i] = cx; ny[i] = cy; nz[i] = cz;
    }
    this.nx = nx; this.ny = ny; this.nz = nz; this.triArea = area;
    this.flippedFaces = flipped;
    this.surfaceArea = area.reduce((s, v) => s + v, 0);
  }

  /** XY 平面の一様グリッドに三角形を登録する（CSR 形式） */
  _buildGrid() {
    const { minE, maxE, minN, maxN } = this.bounds;
    const w = Math.max(maxE - minE, 1e-6), h = Math.max(maxN - minN, 1e-6);
    // 1 セルあたり平均 2 三角形程度を狙う
    const target = Math.max(1, Math.min(this.triCount / 2, 4_000_000));
    let cell = Math.sqrt((w * h) / target);
    if (!isFinite(cell) || cell <= 0) cell = 1;
    let cols = Math.max(1, Math.min(4096, Math.ceil(w / cell)));
    let rows = Math.max(1, Math.min(4096, Math.ceil(h / cell)));
    this.grid = {
      minE, minN,
      cellE: w / cols, cellN: h / rows,
      cols, rows,
    };

    const counts = new Int32Array(cols * rows + 1);
    const visit = (i, fn) => {
      const a = this.faces[i * 3], b = this.faces[i * 3 + 1], c = this.faces[i * 3 + 2];
      const c0 = this._col(Math.min(this.e[a], this.e[b], this.e[c]));
      const c1 = this._col(Math.max(this.e[a], this.e[b], this.e[c]));
      const r0 = this._row(Math.min(this.n[a], this.n[b], this.n[c]));
      const r1 = this._row(Math.max(this.n[a], this.n[b], this.n[c]));
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) fn(r * cols + cc);
    };
    for (let i = 0; i < this.triCount; i++) visit(i, (k) => counts[k + 1]++);
    for (let k = 0; k < cols * rows; k++) counts[k + 1] += counts[k];
    const items = new Int32Array(counts[cols * rows]);
    const cursor = counts.slice(0, cols * rows);
    for (let i = 0; i < this.triCount; i++) visit(i, (k) => { items[cursor[k]++] = i; });
    this.grid.start = counts;
    this.grid.items = items;
  }

  _col(e) {
    const g = this.grid;
    return Math.max(0, Math.min(g.cols - 1, Math.floor((e - g.minE) / g.cellE)));
  }
  _row(n) {
    const g = this.grid;
    return Math.max(0, Math.min(g.rows - 1, Math.floor((n - g.minN) / g.cellN)));
  }

  /**
   * 点 (e,n,h) に最も近い TIN 上の点を探し、法線方向較差を返す。
   * @returns {{deviation:number, tri:number, ce:number, cn:number, ch:number}|null}
   *          設計面の範囲外（maxDistance を超える）場合は null
   *
   * 大量の点を回す場合は deviationAt() を使うこと。こちらは呼び出しごとに
   * オブジェクトを 1 個作るので、数百万点のループに入れると GC が効いて数倍遅くなる。
   */
  closest(e, n, h, maxDistance = 5) {
    const tri = this._search(e, n, h, maxDistance);
    if (tri < 0) return null;
    return {
      deviation: this._signedDistance(tri, e, n, h),
      tri,
      ce: this._cx, cn: this._cy, ch: this._cz,
    };
  }

  /**
   * 法線方向較差だけを返す高速版（返り値はプリミティブ、割り当てゼロ）。
   * 設計面の範囲外なら NaN。
   */
  deviationAt(e, n, h, maxDistance = 5) {
    const tri = this._search(e, n, h, maxDistance);
    if (tri < 0) return NaN;
    return this._signedDistance(tri, e, n, h);
  }

  _signedDistance(tri, e, n, h) {
    const dx = e - this._cx, dy = n - this._cy, dz = h - this._cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dot = dx * this.nx[tri] + dy * this.ny[tri] + dz * this.nz[tri];
    return dot >= 0 ? dist : -dist;
  }

  /**
   * 最近傍三角形を探す。結果の最近傍点は this._cx/_cy/_cz に入れる。
   * ホットパスなのでオブジェクトを一切作らない。
   */
  _search(e, n, h, maxDistance) {
    const g = this.grid;
    const cols = g.cols, rows = g.rows;
    const start = g.start, items = g.items;
    const gMinE = g.minE, gMinN = g.minN, cellE = g.cellE, cellN = g.cellN;
    const c0 = this._col(e), r0 = this._row(n);
    const maxRing = cols > rows ? cols : rows;
    const cellSize = cellE < cellN ? cellE : cellN;
    const maxD2 = maxDistance * maxDistance;

    let best = Infinity, bestTri = -1;
    let bx = 0, by = 0, bz = 0;

    for (let ring = 0; ring <= maxRing; ring++) {
      if (bestTri >= 0) {
        const reach = (ring - 1) * cellSize;
        if (reach > 0 && reach * reach > best) break;
        if (reach > maxDistance) break;
      }
      const rLo = r0 - ring, rHi = r0 + ring, cLo = c0 - ring, cHi = c0 + ring;
      if (rLo < 0 && rHi >= rows && cLo < 0 && cHi >= cols && bestTri >= 0) break;

      for (let r = rLo; r <= rHi; r++) {
        if (r < 0 || r >= rows) continue;
        const onEdgeRow = (r === rLo || r === rHi);
        const rowBase = r * cols;
        // 点からこの行のセル矩形までの南北方向の距離
        const cellN0 = gMinN + r * cellN;
        let dy = 0;
        if (n < cellN0) dy = cellN0 - n;
        else if (n > cellN0 + cellN) dy = n - (cellN0 + cellN);
        const dy2 = dy * dy;
        if (dy2 > best) continue; // 行ごとまとめて足切り

        for (let c = cLo; c <= cHi; c++) {
          if (c < 0 || c >= cols) continue;
          if (ring > 0 && !onEdgeRow && c !== cLo && c !== cHi) continue;
          // 点からセル矩形までの距離（XY 平面）。3D 距離はこれ以上になるので下限として使える。
          const cellE0 = gMinE + c * cellE;
          let dx = 0;
          if (e < cellE0) dx = cellE0 - e;
          else if (e > cellE0 + cellE) dx = e - (cellE0 + cellE);
          if (dx * dx + dy2 > best) continue; // このセルには近い三角形はあり得ない

          const k = rowBase + c;
          for (let si = start[k], se = start[k + 1]; si < se; si++) {
            const ti = items[si];
            const d2 = this._closestOnTriangle(ti, e, n, h);
            if (d2 < best) {
              best = d2; bestTri = ti;
              bx = this._cx; by = this._cy; bz = this._cz;
            }
          }
        }
      }
    }

    if (bestTri < 0 || best > maxD2) return -1;
    this._cx = bx; this._cy = by; this._cz = bz;
    return bestTri;
  }

  /**
   * 三角形上の最近傍点（Ericson, Real-Time Collision Detection）。
   * 最近傍点は this._cx/_cy/_cz に書き、距離の 2 乗を返す。割り当てはしない。
   */
  _closestOnTriangle(ti, pe, pn, ph) {
    const f = this.faces, E = this.e, N = this.n, H = this.h;
    const i3 = ti * 3;
    const ia = f[i3], ib = f[i3 + 1], ic = f[i3 + 2];
    const ax = E[ia], ay = N[ia], az = H[ia];
    const bx = E[ib], by = N[ib], bz = H[ib];
    const cx = E[ic], cy = N[ic], cz = H[ic];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = pe - ax, apy = pn - ay, apz = ph - az;

    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;

    let qx, qy, qz;
    if (d1 <= 0 && d2 <= 0) {
      qx = ax; qy = ay; qz = az;
    } else {
      const bpx = pe - bx, bpy = pn - by, bpz = ph - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) {
        qx = bx; qy = by; qz = bz;
      } else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const v = d1 / (d1 - d3);
          qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
        } else {
          const cpx = pe - cx, cpy = pn - cy, cpz = ph - cz;
          const d5 = abx * cpx + aby * cpy + abz * cpz;
          const d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) {
            qx = cx; qy = cy; qz = cz;
          } else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              const w = d2 / (d2 - d6);
              qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
            } else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
              } else {
                const denom = 1 / (va + vb + vc);
                const v = vb * denom, w = vc * denom;
                qx = ax + abx * v + acx * w;
                qy = ay + aby * v + acy * w;
                qz = az + abz * v + acz * w;
              }
            }
          }
        }
      }
    }

    this._cx = qx; this._cy = qy; this._cz = qz;
    const dx = pe - qx, dy = pn - qy, dz = ph - qz;
    return dx * dx + dy * dy + dz * dz;
  }

  /** 真上から見て (e,n) にある設計面標高。範囲外なら NaN。縦断・横断図で使う。 */
  elevationAt(e, n) {
    const g = this.grid;
    const k = this._row(n) * g.cols + this._col(e);
    for (let s = g.start[k]; s < g.start[k + 1]; s++) {
      const ti = g.items[s];
      const ia = this.faces[ti * 3], ib = this.faces[ti * 3 + 1], ic = this.faces[ti * 3 + 2];
      const x1 = this.e[ia], y1 = this.n[ia], x2 = this.e[ib], y2 = this.n[ib], x3 = this.e[ic], y3 = this.n[ic];
      const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      if (det === 0) continue;
      const l1 = ((y2 - y3) * (e - x3) + (x3 - x2) * (n - y3)) / det;
      const l2 = ((y3 - y1) * (e - x3) + (x1 - x3) * (n - y3)) / det;
      const l3 = 1 - l1 - l2;
      const eps = -1e-9;
      if (l1 >= eps && l2 >= eps && l3 >= eps) return l1 * this.h[ia] + l2 * this.h[ib] + l3 * this.h[ic];
    }
    return NaN;
  }

  /** 三角形の傾斜角（度）。のり面の勾配確認用。 */
  slopeDeg(ti) {
    return Math.acos(Math.min(1, Math.max(-1, this.nz[ti]))) * 180 / Math.PI;
  }
}

/**
 * 設計 TIN をバイナリ化する（"TGND" 形式）。CLI の出力とビューアの取り込みで共用する。
 * 座標はローカル原点からの相対 m を float32 で持つ。生の平面直角座標を float32 に
 * 入れると mm が丸め落ちるので、必ず原点を引いてから格納すること。
 */
export function serializeTin(tin, origin = null) {
  const o = origin ?? [
    (tin.bounds.minE + tin.bounds.maxE) / 2,
    (tin.bounds.minN + tin.bounds.maxN) / 2,
    tin.bounds.minH,
  ];
  const nv = tin.e.length, nt = tin.triCount;
  const buf = new ArrayBuffer(16 + nv * 12 + nt * 12);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x54474e44, true); // "TGND"
  dv.setUint32(4, 1, true);
  dv.setUint32(8, nv, true);
  dv.setUint32(12, nt, true);
  let p = 16;
  for (let i = 0; i < nv; i++, p += 12) {
    dv.setFloat32(p, tin.e[i] - o[0], true);
    dv.setFloat32(p + 4, tin.n[i] - o[1], true);
    dv.setFloat32(p + 8, tin.h[i] - o[2], true);
  }
  for (let i = 0; i < nt * 3; i++, p += 4) dv.setUint32(p, tin.faces[i], true);
  return { bin: new Uint8Array(buf), vertexCount: nv, triangleCount: nt, origin: o };
}
