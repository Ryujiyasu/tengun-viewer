#!/usr/bin/env node
/**
 * ブランド素材（ロゴ SVG）をビューアのバンドルに埋め込む。
 *
 * 外部ファイル参照にすると、閉域網や file:// で開いたときに読めない。
 * SVG をそのまま JS 文字列にして、単一 HTML でも表示できるようにする。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const brandDir = join(HERE, '..', 'brand');
const outDir = join(HERE, '..', 'packages', 'viewer', 'src', 'generated');

/** Illustrator が吐く冗長な属性と改行を落とす。パスの座標には触れない。 */
function tidy(svg) {
  return svg
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s*(?:xml:space|enable-background|id)="[^"]*"/g, '')
    .replace(/\s*style="enable-background[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** クラス名が他の SVG と衝突しないよう接頭辞を付ける */
function namespaceClasses(svg, prefix) {
  return svg
    .replace(/\.st(\d+)\s*\{/g, `.${prefix}st$1{`)
    .replace(/class="st(\d+)"/g, `class="${prefix}st$1"`);
}

const light = namespaceClasses(tidy(await readFile(join(brandDir, 'hatsuki-logo.svg'), 'utf8')), 'hl-');
const white = namespaceClasses(tidy(await readFile(join(brandDir, 'hatsuki-logo-white.svg'), 'utf8')), 'hw-');

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'brand.js'), `// 自動生成ファイル。編集しないこと。tools/embed-brand.mjs が作る。
// 素材は brand/ 以下。葉月工業株式会社のロゴ。

export const BRAND = {
  companyName: '葉月工業株式会社',
  companyNameKana: 'ハツキコウギョウ',
  url: 'https://hatsuki.co.jp/',
  productName: '点群ビューア',
  colors: { green: '#008746', blueGray: '#83A1B1', dark: '#231815' },
};

/** 明るい背景用（横組み） */
export const LOGO_SVG = ${JSON.stringify(light)};

/** 暗い背景用（白抜き・縦組み） */
export const LOGO_WHITE_SVG = ${JSON.stringify(white)};
`, 'utf8');

console.log(`ブランド素材を埋め込みました: ${join(outDir, 'brand.js')}`);
console.log(`  明るい背景用 ${light.length} バイト / 暗い背景用 ${white.length} バイト`);
