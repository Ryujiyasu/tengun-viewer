import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readLasHeader, readLasPoints } from '@tengun/core';

/** LAS / LAZ を読む。LAZ は laz-perf(WASM) で解凍してから共通処理に載せる。 */
export async function readPointFile(path, { onLog = () => {} } = {}) {
  const raw = new Uint8Array(await readFile(path));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const header = readLasHeader(raw);

  let points;
  if (header.compressed || /\.laz$/i.test(path)) {
    onLog(`  LAZ を解凍中…（laz-perf/WASM）`);
    points = await decompressLaz(raw, header);
  } else {
    points = readLasPoints(raw, header);
  }
  return { points, header, sha256, bytes: raw.byteLength };
}

async function decompressLaz(raw, header) {
  const { createLazPerf } = await import('laz-perf');
  const LazPerf = await createLazPerf();

  const filePtr = LazPerf._malloc(raw.byteLength);
  LazPerf.HEAPU8.set(raw, filePtr);
  const laszip = new LazPerf.LASZip();
  laszip.open(filePtr, raw.byteLength);

  const recLen = laszip.getPointLength();
  const count = laszip.getCount();
  const fmt = laszip.getPointFormat();
  const pointPtr = LazPerf._malloc(recLen);

  // 解凍結果を非圧縮 LAS と同じレイアウトのバッファに詰め直し、共通の読み取りに渡す
  const HEADER = 375;
  const buf = new Uint8Array(HEADER + recLen * count);
  const dv = new DataView(buf.buffer);
  buf.set([0x4c, 0x41, 0x53, 0x46], 0);
  dv.setUint8(24, 1); dv.setUint8(25, 4);
  dv.setUint16(94, HEADER, true);
  dv.setUint32(96, HEADER, true);
  dv.setUint8(104, fmt);
  dv.setUint16(105, recLen, true);
  dv.setUint32(107, count > 0xffffffff ? 0 : count, true);
  dv.setBigUint64(247, BigInt(count), true);
  for (let k = 0; k < 3; k++) dv.setFloat64(131 + k * 8, header.scale[k], true);
  for (let k = 0; k < 3; k++) dv.setFloat64(155 + k * 8, header.offset[k], true);

  for (let i = 0; i < count; i++) {
    laszip.getPoint(pointPtr);
    buf.set(LazPerf.HEAPU8.subarray(pointPtr, pointPtr + recLen), HEADER + i * recLen);
  }
  laszip.delete();
  LazPerf._free(pointPtr);
  LazPerf._free(filePtr);

  const h2 = readLasHeader(buf);
  h2.bounds = header.bounds;
  return readLasPoints(buf, h2);
}

/**
 * 工事情報の axisOrder に従って軸を入れ替える。
 * EN = LAS の X が東・Y が北（一般的）。NE = X が北・Y が東（測量座標をそのまま入れた場合）。
 */
export function applyAxisOrder(points, axisOrder) {
  if (axisOrder === 'NE') {
    const t = points.e; points.e = points.n; points.n = t;
  } else if (axisOrder && axisOrder !== 'EN') {
    throw new Error(`axisOrder は EN か NE を指定してください: ${axisOrder}`);
  }
  return points;
}
