/**
 * ブラウザ側で LAS / LAZ を読む。
 *
 * laz-perf は lib/web 版を使う。既定の lib/laz-perf.js は Node 用に fs/path を
 * require しており、バンドルすると警告が出るうえ無駄が入る。
 *
 * LAZ は laz-perf(WASM)。.wasm は base64 で同梱してバイト列として渡すので、
 * file:// で開いた単一 HTML でも動く（.wasm を fetch すると CORS で失敗する）。
 */
import { readLasHeader, readLasPoints } from '@tengun/core';
import { lazPerfWasmBytes } from '../generated/laz-perf-wasm.js';

let lazPerfPromise = null;
function getLazPerf() {
  if (!lazPerfPromise) {
    lazPerfPromise = import('laz-perf/lib/web/laz-perf.js').then(({ default: createLazPerf }) =>
      createLazPerf({ wasmBinary: lazPerfWasmBytes() })
    );
  }
  return lazPerfPromise;
}

/** @param {ArrayBuffer} buffer */
export async function readPointBuffer(buffer, { onProgress } = {}) {
  const raw = new Uint8Array(buffer);
  const header = readLasHeader(raw);
  if (!header.compressed) return { points: readLasPoints(raw, header), header };

  onProgress?.({ phase: 'LAZ を解凍中', done: 0, total: header.pointCount });
  const LazPerf = await getLazPerf();
  const filePtr = LazPerf._malloc(raw.byteLength);
  LazPerf.HEAPU8.set(raw, filePtr);
  const laszip = new LazPerf.LASZip();
  try {
    laszip.open(filePtr, raw.byteLength);
    const recLen = laszip.getPointLength();
    const count = laszip.getCount();
    const fmt = laszip.getPointFormat();
    const pointPtr = LazPerf._malloc(recLen);

    // 非圧縮 LAS と同じ並びに詰め直して、共通の読み取りに渡す
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

    const step = Math.max(1, Math.floor(count / 50));
    for (let i = 0; i < count; i++) {
      laszip.getPoint(pointPtr);
      buf.set(LazPerf.HEAPU8.subarray(pointPtr, pointPtr + recLen), HEADER + i * recLen);
      if (i % step === 0) onProgress?.({ phase: 'LAZ を解凍中', done: i, total: count });
    }
    LazPerf._free(pointPtr);

    const h2 = readLasHeader(buf);
    h2.bounds = header.bounds;
    return { points: readLasPoints(buf, h2), header: h2 };
  } finally {
    laszip.delete();
    LazPerf._free(filePtr);
  }
}

/** 拡張子と中身から役割を推定する */
export function classifyFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.las') || name.endsWith('.laz')) return 'points';
  if (name.endsWith('.xml')) return 'design';
  if (name.endsWith('.json')) return 'info';
  return 'unknown';
}
