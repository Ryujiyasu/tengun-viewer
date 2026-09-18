import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VIEWER_DIST = join(HERE, '..', '..', 'viewer', 'dist');

export async function loadViewerAssets() {
  const js = join(VIEWER_DIST, 'viewer.js');
  const css = join(VIEWER_DIST, 'viewer.css');
  if (!existsSync(js)) {
    throw new Error(
      `ビューアがビルドされていません: ${js}\n  先に  npm run build  を実行してください。`
    );
  }
  return {
    js: await readFile(js, 'utf8'),
    css: existsSync(css) ? await readFile(css, 'utf8') : '',
  };
}

// JSON を <script> に埋める際に潰す必要がある文字（U+2028/U+2029 は JS では改行扱い）
const SEP_RE = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** JSON を <script> に安全に埋める（</script> とU+2028/2029 を潰す） */
function embedJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(SEP_RE, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

export function renderIndexHtml({ config, assets, inlineData }) {
  const title = `${config.info.projectName ?? '点群ビューア'} — 点群ビューア`;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="generator" content="tengun ptv">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%225%22%20fill%3D%22%231f5fa8%22%2F%3E%3Cg%20fill%3D%22%23fff%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%2221%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2214%22%20cy%3D%2218%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2220%22%20cy%3D%2214%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2226%22%20cy%3D%2210%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%229%22%20cy%3D%2213%22%20r%3D%221.4%22%20opacity%3D%22.65%22%2F%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2224%22%20r%3D%221.4%22%20opacity%3D%22.65%22%2F%3E%3Ccircle%20cx%3D%2223%22%20cy%3D%2220%22%20r%3D%221.4%22%20opacity%3D%22.65%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E">
<style>${assets.css}</style>
</head>
<body>
<div id="app">
  <noscript><div class="boot-error"><h1>JavaScript が無効です</h1><p>このビューアは JavaScript を使用します。ブラウザの設定で有効にしてから開き直してください。</p></div></noscript>
  <div id="boot" class="boot">読み込み中…</div>
</div>
<script type="application/json" id="tengun-config">${embedJson(config)}</script>
${inlineData ? `<script type="application/json" id="tengun-data">${embedJson(inlineData)}</script>` : ''}
<script>${assets.js}</script>
<script>
(function () {
  var cfg = JSON.parse(document.getElementById('tengun-config').textContent);
  var dataEl = document.getElementById('tengun-data');
  if (dataEl) cfg.inline = JSON.parse(dataEl.textContent);
  if (!window.Tengun || !window.Tengun.start) {
    document.getElementById('boot').innerHTML =
      '<div class="boot-error"><h1>ビューアの読み込みに失敗しました</h1><p>ファイルが壊れているか、途中までしかコピーされていない可能性があります。フォルダごと受け取り直してください。</p></div>';
    return;
  }
  window.Tengun.start(cfg, document.getElementById('app'));
})();
</script>
</body>
</html>
`;
}

/** Uint8Array → base64（大きい配列でもスタックを壊さないよう分割） */
export function toBase64(u8) {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
}
