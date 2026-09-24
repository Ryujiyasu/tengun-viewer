#!/usr/bin/env node
/**
 * docs/使い方.md から配布用の PDF を作る。
 *
 * 説明書の本文は Markdown を単一の情報源にする。画面を直したら
 * record-guide.mjs でキャプチャを撮り直し、このツールで PDF を作り直せばよい。
 * PDF に直接書くと、内容が二重管理になって必ずずれる。
 *
 *   node tools/make-guide-pdf.mjs [出力先.pdf]
 */
import { readFile, stat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mdToHtml, wrapHtml, loadLogo, renderPdf } from './lib/mdpdf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'docs', '使い方.md');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'dist', '点群ビューア_使い方.pdf'));

await mkdir(dirname(OUT), { recursive: true });
const md = await readFile(SRC, 'utf8');
// 先頭の見出しと導入は表紙で扱うので本文からは外す
const body = await mdToHtml(md.replace(/^#\s+.*\n/, ''), join(ROOT, 'docs'));
const logo = await loadLogo(ROOT);

const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });

const html = wrapHtml({
  logo, title: '点群ビューア<br>使い方',
  lead: 'ドローン等で取得した3次元点群を、専用ソフトを入れずに<br>'
      + 'ブラウザだけで確認するためのビューアです。<br>'
      + '設計データとのズレと、出来形の合否判定までご覧いただけます。',
  meta: [
    ['お渡しする方', '工事の出来形を確認される方（発注者の技術職員の方）'],
    ['必要なもの', 'Microsoft Edge または Google Chrome。インストール作業は不要です'],
    ['発行', `${today}　提供　葉月工業株式会社　https://hatsuki.co.jp/`],
  ],
  body,
});

const previewIdx = process.argv.indexOf('--preview');
await renderPdf(html, OUT, {
  footerText: '点群ビューア 使い方　／　葉月工業株式会社',
  preview: previewIdx >= 0 ? join(process.argv[previewIdx + 1] ?? join(ROOT, 'dist'), 'guide-preview.png') : null,
});

const size = (await stat(OUT)).size;
console.log(`PDF を作成しました: ${OUT}  ${(size / 1048576).toFixed(2)} MB`);
