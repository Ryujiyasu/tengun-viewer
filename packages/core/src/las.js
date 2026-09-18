/**
 * LAS 1.2 / 1.3 / 1.4 の読み書き（非圧縮）。
 * LAZ は WASM（laz-perf）が要るので CLI 側で解凍してからここに渡す。
 *
 * 軸: LAS の X = 東(easting), Y = 北(northing), Z = 標高。
 *     日本の公共座標 (X=北, Y=東) との入れ替えは呼び出し側（工事情報の axisOrder）で行う。
 */

const POINT_RECORD_LENGTH = { 0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 };

export function readLasHeader(buf) {
  const dv = new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('LAS ファイルではありません（先頭 4 バイトが "LASF" でない）');

  const versionMajor = dv.getUint8(24);
  const versionMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const offsetToPointData = dv.getUint32(96, true);
  const numVlrs = dv.getUint32(100, true);
  const pointDataRecordFormat = dv.getUint8(104) & 0b00111111; // 上位2bitは圧縮フラグ
  const compressed = (dv.getUint8(104) & 0x80) !== 0;
  const pointDataRecordLength = dv.getUint16(105, true);
  let pointCount = dv.getUint32(107, true);

  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const maxE = dv.getFloat64(179, true), minE = dv.getFloat64(187, true);
  const maxN = dv.getFloat64(195, true), minN = dv.getFloat64(203, true);
  const maxH = dv.getFloat64(211, true), minH = dv.getFloat64(219, true);

  if (versionMajor === 1 && versionMinor >= 4 && headerSize >= 375) {
    const big = dv.getBigUint64(247, true);
    if (big > 0n) {
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('点数が多すぎます');
      pointCount = Number(big);
    }
  }

  const systemIdentifier = readChars(dv, 26, 32);
  const generatingSoftware = readChars(dv, 58, 32);
  const creationDayOfYear = dv.getUint16(90, true);
  const creationYear = dv.getUint16(92, true);

  return {
    version: `${versionMajor}.${versionMinor}`,
    versionMajor, versionMinor,
    headerSize, offsetToPointData, numVlrs,
    pointDataRecordFormat, pointDataRecordLength, compressed,
    pointCount,
    scale, offset,
    bounds: { minE, maxE, minN, maxN, minH, maxH },
    systemIdentifier, generatingSoftware, creationYear, creationDayOfYear,
    hasColor: [2, 3, 5, 7, 8, 10].includes(pointDataRecordFormat),
  };
}

function readChars(dv, at, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** 点データ部のバイト位置（フォーマット別） */
function fieldOffsets(fmt) {
  if (fmt <= 5) {
    const o = { intensity: 12, flags: 14, classification: 15, scanAngle: 16, userData: 17, pointSource: 18 };
    if (fmt === 0) return { ...o, rgb: -1 };
    if (fmt === 1) return { ...o, rgb: -1, gpsTime: 20 };
    if (fmt === 2) return { ...o, rgb: 20 };
    if (fmt === 3) return { ...o, gpsTime: 20, rgb: 28 };
    if (fmt === 4) return { ...o, gpsTime: 20, rgb: -1 };
    return { ...o, gpsTime: 20, rgb: 28 };
  }
  // 1.4 の新フォーマット（6..10）
  const o = { intensity: 12, flags: 14, classification: 16, userData: 17, scanAngle: 18, pointSource: 20, gpsTime: 22 };
  if (fmt === 6) return { ...o, rgb: -1 };
  if (fmt === 7) return { ...o, rgb: 30 };
  if (fmt === 8) return { ...o, rgb: 30, nir: 36 };
  if (fmt === 9) return { ...o, rgb: -1 };
  return { ...o, rgb: 30 };
}

/**
 * 点データ部を SoA（Structure of Arrays）に展開する。
 * 座標は倍精度で保持する。ここで float32 に落とすと mm 精度が壊れる。
 */
export function readLasPoints(buf, header, { stride = 1 } = {}) {
  const h = header ?? readLasHeader(buf);
  if (h.compressed) throw new Error('圧縮（LAZ）データです。先に解凍してから渡してください');
  const base = buf.byteOffset ?? 0;
  const dv = new DataView(buf.buffer ?? buf, base, buf.byteLength);
  const rec = h.pointDataRecordLength || POINT_RECORD_LENGTH[h.pointDataRecordFormat];
  const f = fieldOffsets(h.pointDataRecordFormat);

  const n = Math.ceil(h.pointCount / stride);
  const e = new Float64Array(n), north = new Float64Array(n), hh = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const rgb = f.rgb >= 0 ? new Uint8Array(n * 3) : null;

  const [sx, sy, sz] = h.scale;
  const [ox, oy, oz] = h.offset;

  let w = 0;
  for (let i = 0; i < h.pointCount; i += stride) {
    const p = h.offsetToPointData + i * rec;
    e[w] = dv.getInt32(p, true) * sx + ox;
    north[w] = dv.getInt32(p + 4, true) * sy + oy;
    hh[w] = dv.getInt32(p + 8, true) * sz + oz;
    intensity[w] = dv.getUint16(p + f.intensity, true);
    classification[w] = h.pointDataRecordFormat <= 5
      ? dv.getUint8(p + f.classification) & 0b00011111
      : dv.getUint8(p + f.classification);
    if (rgb) {
      // LAS の色は 16bit。8bit しか入っていないファイルも多いので実データを見て正規化する
      rgb[w * 3] = dv.getUint16(p + f.rgb, true) >> 8;
      rgb[w * 3 + 1] = dv.getUint16(p + f.rgb + 2, true) >> 8;
      rgb[w * 3 + 2] = dv.getUint16(p + f.rgb + 4, true) >> 8;
    }
    w++;
  }

  // 8bit で格納されていたファイルの救済: 全成分が 0 なら 16bit 前提の右シフトが誤り
  if (rgb) {
    let max = 0;
    for (let i = 0; i < rgb.length; i += 997) max = Math.max(max, rgb[i]);
    if (max === 0) {
      for (let i = 0; i < w; i++) {
        const p = h.offsetToPointData + i * stride * rec;
        rgb[i * 3] = dv.getUint16(p + f.rgb, true) & 0xff;
        rgb[i * 3 + 1] = dv.getUint16(p + f.rgb + 2, true) & 0xff;
        rgb[i * 3 + 2] = dv.getUint16(p + f.rgb + 4, true) & 0xff;
      }
    }
  }

  return { count: w, e, n: north, h: hh, intensity, classification, rgb, header: h };
}

/**
 * SoA から LAS 1.2 point format 2（XYZ + Intensity + RGB）を書き出す。
 * 試験データ生成と、内部で持ち回ったデータの書き戻しに使う。
 */
export function writeLas(points, { scale = [0.001, 0.001, 0.001], generatingSoftware = 'tengun ptv' } = {}) {
  const n = points.count;
  const HEADER = 227;
  const REC = 26;
  const buf = new ArrayBuffer(HEADER + REC * n);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < n; i++) {
    if (points.e[i] < minE) minE = points.e[i];
    if (points.e[i] > maxE) maxE = points.e[i];
    if (points.n[i] < minN) minN = points.n[i];
    if (points.n[i] > maxN) maxN = points.n[i];
    if (points.h[i] < minH) minH = points.h[i];
    if (points.h[i] > maxH) maxH = points.h[i];
  }
  // オフセットは bbox 中心の切り下げ。原点から遠い座標を int32 に収めるため必須。
  const offset = [Math.floor(minE), Math.floor(minN), Math.floor(minH)];

  u8.set([0x4c, 0x41, 0x53, 0x46], 0); // "LASF"
  dv.setUint8(24, 1); dv.setUint8(25, 2); // version 1.2
  writeChars(u8, 26, 32, 'tengun');
  writeChars(u8, 58, 32, generatingSoftware);
  const now = new Date();
  const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  dv.setUint16(90, doy, true);
  dv.setUint16(92, now.getFullYear(), true);
  dv.setUint16(94, HEADER, true);
  dv.setUint32(96, HEADER, true);
  dv.setUint32(100, 0, true);
  dv.setUint8(104, 2);
  dv.setUint16(105, REC, true);
  dv.setUint32(107, n, true);
  dv.setUint32(111, n, true); // number by return[0]
  dv.setFloat64(131, scale[0], true); dv.setFloat64(139, scale[1], true); dv.setFloat64(147, scale[2], true);
  dv.setFloat64(155, offset[0], true); dv.setFloat64(163, offset[1], true); dv.setFloat64(171, offset[2], true);
  dv.setFloat64(179, maxE, true); dv.setFloat64(187, minE, true);
  dv.setFloat64(195, maxN, true); dv.setFloat64(203, minN, true);
  dv.setFloat64(211, maxH, true); dv.setFloat64(219, minH, true);

  for (let i = 0; i < n; i++) {
    const p = HEADER + i * REC;
    dv.setInt32(p, Math.round((points.e[i] - offset[0]) / scale[0]), true);
    dv.setInt32(p + 4, Math.round((points.n[i] - offset[1]) / scale[1]), true);
    dv.setInt32(p + 8, Math.round((points.h[i] - offset[2]) / scale[2]), true);
    dv.setUint16(p + 12, points.intensity ? points.intensity[i] : 0, true);
    dv.setUint8(p + 14, 0b00010001); // return 1 of 1
    dv.setUint8(p + 15, points.classification ? points.classification[i] : 0);
    dv.setInt8(p + 16, 0);
    dv.setUint8(p + 17, 0);
    dv.setUint16(p + 18, 0, true);
    if (points.rgb) {
      dv.setUint16(p + 20, points.rgb[i * 3] << 8, true);
      dv.setUint16(p + 22, points.rgb[i * 3 + 1] << 8, true);
      dv.setUint16(p + 24, points.rgb[i * 3 + 2] << 8, true);
    }
  }
  return new Uint8Array(buf);
}

function writeChars(u8, at, len, s) {
  for (let i = 0; i < len; i++) u8[at + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0;
}

export const LAS_CLASSIFICATION_NAMES = {
  0: '未分類', 1: '未割当', 2: '地表面', 3: '低植生', 4: '中植生', 5: '高植生',
  6: '建物', 7: 'ノイズ', 9: '水面', 11: '路面', 13: 'ガードレール', 17: '橋梁',
};
