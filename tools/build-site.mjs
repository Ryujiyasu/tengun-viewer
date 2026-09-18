#!/usr/bin/env node
/**
 * 公開用サイトを組み立てる。
 *
 * トップページは置かない。URL を開いたら直接ビューアが立ち上がる。
 * 動作環境の確認はビューア起動時のダイアログで出るので、説明ページは要らない。
 *
 *   site-build/            ← ここがそのまま公開される
 *     index.html           ビューア本体（フル版）
 *     viewer.js / .css
 *     data/*.bin
 *     report/*.csv, *.svg
 *     light/index.html     配布用の単一 HTML（ダウンロード用に残す）
 */
import { cp, mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const src = resolve(process.argv[2] ?? 'site-build');
const full = join(src, 'full');
const light = join(src, 'light');

// full/ の中身をそのまま公開ルートへ移す
for (const name of await readdir(full)) {
  await rm(join(src, name), { recursive: true, force: true });
  await cp(join(full, name), join(src, name), { recursive: true });
}
await rm(full, { recursive: true, force: true });

// light はダウンロード用に残す
if (await stat(light).then(() => true).catch(() => false)) {
  // そのまま
}

// Jekyll の処理を止める（_ で始まるファイルや日本語名を素通しさせる）
await writeFile(join(src, '.nojekyll'), '');

const list = async (d, p = '') => {
  const out = [];
  for (const n of await readdir(d)) {
    const f = join(d, n);
    if ((await stat(f)).isDirectory()) out.push(...await list(f, `${p}${n}/`));
    else out.push(`${p}${n}`);
  }
  return out;
};
console.log('公開サイトを組み立てました:');
for (const f of (await list(src)).sort()) console.log(`  ${f}`);
