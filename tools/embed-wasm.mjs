#!/usr/bin/env node
/**
 * laz-perf の WASM を base64 の JS モジュールとして埋め込む。
 *
 * .wasm を別ファイルで置くと file:// では CORS で読めない。
 * Emscripten の wasmBinary オプションにバイト列を直接渡せば fetch が発生しないので、
 * 単一 HTML（軽量版）でも LAZ が開ける。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = join(HERE, '..', 'node_modules', 'laz-perf', 'lib', 'laz-perf.wasm');
const outDir = join(HERE, '..', 'packages', 'viewer', 'src', 'generated');
const out = join(outDir, 'laz-perf-wasm.js');

const wasm = await readFile(src);
await mkdir(outDir, { recursive: true });
await writeFile(out, `// 自動生成ファイル。編集しないこと。tools/embed-wasm.mjs が作る。
// laz-perf の WASM (${wasm.byteLength} バイト) を base64 で埋め込む。
// file:// では .wasm を fetch できないため、バイト列を直接 Emscripten に渡す。
export const LAZ_PERF_WASM_BASE64 = '${wasm.toString('base64')}';

export function lazPerfWasmBytes() {
  const bin = atob(LAZ_PERF_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
`, 'utf8');
console.log(`埋め込み完了: ${out}  (${(wasm.byteLength / 1024).toFixed(0)} KB → base64 ${(wasm.toString('base64').length / 1024).toFixed(0)} KB)`);
