#!/usr/bin/env node
/**
 * docs/ 以下の Markdown から配布用 PDF を作る。
 *
 *   node tools/make-doc-pdf.mjs docs/NEDO-点群データの自動処理.md dist/out.pdf \
 *     --title "点群データの<br>自動処理" --lead "..." [--preview 画像.png]
 *
 * 表紙の文言は引数で渡す。本文は Markdown を単一の情報源にする。
 */
import { readFile, stat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mdToHtml, wrapHtml, loadLogo, renderPdf } from './lib/mdpdf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

const src = resolve(positional[0] ?? join(ROOT, 'docs', 'NEDO-点群データの自動処理.md'));
const out = resolve(positional[1] ?? join(ROOT, 'dist', 'doc.pdf'));
await mkdir(dirname(out), { recursive: true });

const md = await readFile(src, 'utf8');
const firstHeading = (md.match(/^#\s+(.*)$/m) ?? [, '資料'])[1];
const title = opt('title', firstHeading);
const lead = opt('lead', '');
const footer = opt('footer', `${firstHeading}　／　葉月工業株式会社`);
const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });

const body = await mdToHtml(md.replace(/^#\s+.*\n/, ''), join(ROOT, 'docs'));
const html = wrapHtml({
  logo: await loadLogo(ROOT),
  title, lead,
  meta: [
    ['作成', today],
    ['提供', '葉月工業株式会社　https://hatsuki.co.jp/'],
  ],
  body,
});

await renderPdf(html, out, { footerText: footer, preview: opt('preview') });
console.log(`PDF を作成しました: ${out}  ${((await stat(out)).size / 1048576).toFixed(2)} MB`);
