/**
 * Markdown から配布用 PDF を作る共通処理。
 *
 * 本文は Markdown を単一の情報源にする。PDF に直接書くと内容が二重管理になり、
 * 必ずずれる。画面を直したらキャプチャを撮り直して、ここから作り直せばよい。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { findChrome, chromeArgs } from './chrome.mjs';

const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/**
 * Markdown の改行は段落内では空白になるが、日本語の文中で空白を入れると不自然。
 * 境目の両側が英数字のときだけ空白を入れる。
 */
function joinLines(lines) {
  return lines.reduce((acc, cur) => {
    if (!acc) return cur;
    const a = acc[acc.length - 1], b = cur[0];
    const ascii = (c) => /[0-9A-Za-z)\]}>.,;:!?"']/.test(c);
    return acc + (ascii(a) && ascii(b) ? ' ' : '') + cur;
  }, '');
}

/** 行内記法（**太字** `コード` [文字](url)） */
function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) =>
      /^https?:/.test(href) ? `<a href="${href}">${label}</a>` : `<span class="ref">${label}</span>`);
}

/** 画像を data URI にする。外部参照のままだと PDF に載らない。 */
async function imageDataUri(relPath, imageRoot) {
  const p = join(imageRoot, decodeURIComponent(relPath));
  const buf = await readFile(p);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

export async function mdToHtml(md, imageRoot) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let inQuote = false;

  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };

  while (i < lines.length) {
    const line = lines[i];

    // 表
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const head = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      closeQuote();
      out.push('<table><thead><tr>'
        + head.map((c) => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    // 画像
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      closeQuote();
      out.push(`<figure><img src="${await imageDataUri(img[2], imageRoot)}" alt="${esc(img[1])}">`
        + (img[1] ? `<figcaption>${esc(img[1])}</figcaption>` : '') + '</figure>');
      i++; continue;
    }

    // 見出し
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeQuote();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++; continue;
    }

    if (/^---+\s*$/.test(line)) { closeQuote(); out.push('<hr>'); i++; continue; }

    // 引用（注意書き）
    if (/^>\s?/.test(line)) {
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      const body = line.replace(/^>\s?/, '');
      if (body.trim()) out.push(`<p>${inline(body)}</p>`);
      i++; continue;
    }

    // 箇条書き・番号付き
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && (/^[-*]\s+/.test(lines[i]) || /^\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^([-*]|\d+\.)\s+/, ''));
        i++;
      }
      closeQuote();
      out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    if (!line.trim()) { closeQuote(); i++; continue; }

    // 生 HTML はそのまま通さない（配布物なので素の段落にする）
    if (/^<\/?div/.test(line.trim())) { i++; continue; }

    // 空行までを 1 段落にまとめる。
    // 1 行ずつ <p> にすると、段落が途中で切れるうえ、
    // 行をまたぐ **強調** が閉じられず記号のまま出てしまう。
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !/^(#{1,4}\s|[-*]\s|\d+\.\s|>|\||!\[|---+\s*$|<\/?div)/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) { closeQuote(); out.push(`<p>${inline(joinLines(para))}</p>`); continue; }
    i++;
  }
  closeQuote();
  return out.join('\n');
}


/** 表紙と本文の体裁。ブランドの色と葉月工業のロゴを使う。 */
export function wrapHtml({ logo, title, lead, meta, body }) {
  const metaRows = (meta ?? []).map(([k, v]) => `<p><b>${k}</b>　${v}</p>`).join('');
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>${title.replace(/<br>/g, ' ')}</title>
<style>
  @page { size: A4; margin: 16mm 15mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #231815; font-size: 10.5pt; line-height: 1.85;
    font-family: "Hiragino Sans", "Yu Gothic", "Noto Sans CJK JP", "Meiryo", sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .cover { page-break-after: always; padding-top: 34mm; }
  .cover .logo svg { height: 34px; width: auto; }
  .cover h1 { font-size: 27pt; margin: 26mm 0 6mm; letter-spacing: .02em; line-height: 1.35; }
  .cover .lead { font-size: 11.5pt; color: #566268; line-height: 2; margin: 0 0 22mm; }
  .cover .meta { font-size: 10pt; color: #566268; border-top: 2px solid #008746; padding-top: 5mm; }
  .cover .meta b { color: #231815; }
  .cover .meta p { margin: 0 0 1.5mm; }
  h2 { font-size: 15pt; margin: 11mm 0 4mm; padding: 0 0 2mm 0; border-bottom: 2px solid #008746; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 7mm 0 3mm; page-break-after: avoid; }
  p { margin: 0 0 3.5mm; }
  hr { border: 0; border-top: 1px solid #d2dade; margin: 8mm 0; }
  a { color: #1f5fa8; text-decoration: none; word-break: break-all; }
  code { background: #eef1f3; padding: 0 3px; border-radius: 2px; font-size: 9.5pt; }
  .ref { color: #566268; }
  ul, ol { margin: 0 0 4mm; padding-left: 6mm; }
  li { margin-bottom: 1.6mm; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 5mm; font-size: 9.5pt; page-break-inside: avoid; }
  th, td { border: 1px solid #c3ccd1; padding: 2mm 2.5mm; text-align: left; vertical-align: top; }
  th { background: #eef3f5; font-weight: 700; white-space: nowrap; }
  figure { margin: 0 0 6mm; page-break-inside: avoid; }
  figure img { width: 100%; border: 1px solid #c3ccd1; display: block; }
  figcaption { font-size: 8.5pt; color: #8b979d; margin-top: 1.5mm; }
  blockquote { margin: 0 0 5mm; padding: 3mm 4mm; background: #fdf6e8; border-left: 3px solid #d99a2b; page-break-inside: avoid; }
  blockquote p { margin: 0 0 1.5mm; font-size: 9.5pt; }
  blockquote p:last-child { margin-bottom: 0; }
</style></head><body>
<div class="cover">
  <div class="logo">${logo}</div>
  <h1>${title}</h1>
  <p class="lead">${lead}</p>
  <div class="meta">${metaRows}</div>
</div>
${body}
</body></html>`;
}

/** ロゴ SVG を読んでクラス名の衝突を避ける */
export async function loadLogo(root) {
  return (await readFile(join(root, 'brand', 'hatsuki-logo.svg'), 'utf8'))
    .replace(/<\?xml[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\.st(\d+)\s*\{/g, '.pdf-st$1{').replace(/class="st(\d+)"/g, 'class="pdf-st$1"').trim();
}

/** HTML を PDF にする。footerText はページ下に入れる文字列。 */
export async function renderPdf(html, out, { footerText, preview = null } = {}) {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: findChrome(), args: chromeArgs() });
  const page = await browser.newPage();
  await page.setViewport({ width: 794, height: 1123 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluateHandle('document.fonts.ready');
  await page.pdf({
    path: out, format: 'A4', printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:7.5pt;color:#8b979d;padding:0 15mm;'
      + "font-family:'Hiragino Sans',sans-serif;display:flex;justify-content:space-between;\">"
      + `<span>${footerText}</span>`
      + '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margin: { top: '16mm', right: '15mm', bottom: '18mm', left: '15mm' },
  });
  if (preview) await page.screenshot({ path: preview, fullPage: true });
  await browser.close();
}
