/** 画面構成。発注者が最初に見るのは平面図＋較差カラーマップ。 */
import { deviationCss, DEVIATION_STOPS, rampCss, CLASS_COLORS, CLASS_NAMES } from './colors.js';
import { BRAND, LOGO_SVG } from './generated/brand.js';

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const mm = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : (v * 1000).toFixed(d));

export function buildLayout(root, config) {
  root.innerHTML = '';
  const info = config.info ?? {};
  // 判定結果は様式-31-2（sheet）が正。旧形式(judgement)しかない場合はそちらを見る。
  const verdict = config.sheet
    ? { pass: config.sheet.pass, text: config.sheet.verdict }
    : config.judgement
      ? { pass: config.judgement.pass, text: config.judgement.pass ? '合格' : '不合格' }
      : { pass: null, text: '判定なし' };

  const badge = h('span', {
    class: `badge ${verdict.pass === null ? 'none' : verdict.pass ? 'pass' : 'fail'}`,
    text: `判定 ${verdict.text}`,
  });

  const tabs = h('div', { class: 'tabs' }, [
    h('button', { class: 'tab active', 'data-view': 'plan', text: '平面' }),
    h('button', { class: 'tab', 'data-view': '3d', text: '3D' }),
    h('button', { class: 'tab', 'data-view': 'section', text: '断面' }),
  ]);

  const brandBlock = h('a', {
    class: 'brand', href: BRAND.url, target: '_blank', rel: 'noopener noreferrer',
    title: `${BRAND.companyName}　${BRAND.productName}`,
  }, [
    h('span', { class: 'brand-logo', html: LOGO_SVG }),
    h('span', { class: 'brand-product', text: BRAND.productName }),
  ]);

  const openDataBtn = h('button', { class: 'hdr-btn', id: 'open-data-btn' }, [
    h('span', { class: 'hdr-btn-icon', html:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
      + '<path d="M8 11V2M8 2L4.5 5.5M8 2l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M2 10v3.2h12V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
    'データを開く',
  ]);

  const header = h('header', { class: 'app-header' }, [
    brandBlock,
    h('div', { class: 'title-block' }, [
      h('div', { class: 'project-name', text: info.projectName ?? '（工事名未設定）' }),
      h('div', { class: 'project-meta', text: [
        info.projectNumber && `工事番号 ${info.projectNumber}`,
        info.owner && `発注者 ${info.owner}`,
        info.contractor && `受注者 ${info.contractor}`,
        (info.startDate || info.endDate) && `工期 ${info.startDate ?? ''}〜${info.endDate ?? ''}`,
      ].filter(Boolean).join('　/　') }),
    ]),
    h('div', { class: 'header-right' }, [openDataBtn, tabs, badge]),
  ]);

  const canvasHost = h('div', { class: 'canvas-host' }, [
    h('div', { class: 'view-hint', id: 'view-hint' }),
    // 3D の操作方法は書いてないと分からない。常に出しておく。
    h('div', { class: 'controls-hint', id: 'controls-hint' }),
    h('div', { class: 'north', id: 'north', html:
      '<svg viewBox="0 0 40 46" width="40" height="46">'
      + '<polygon points="20,6 26,30 20,25 14,30" fill="#1d2733"/>'
      + '<text x="20" y="43" font-size="11" font-weight="700" fill="#1d2733" text-anchor="middle" font-family="sans-serif">N</text>'
      + '</svg>' }),
    h('div', { class: 'scalebar', id: 'scalebar' }),
    h('div', { class: 'readout', id: 'readout' }),
  ]);

  const side = h('aside', { class: 'side' });
  const bottom = h('section', { class: 'bottom', id: 'bottom' });

  const main = h('div', { class: 'app-main' }, [
    h('div', { class: 'view-col' }, [canvasHost, bottom]),
    side,
  ]);

  // 文字を入れるのは中の span。footer 自体に textContent を入れると
  // 中身ごと消えて #status が無くなる。
  const statusText = h('span', { id: 'status', class: 'status-text' });
  const status = h('footer', { class: 'app-status' }, [
    statusText,
    h('span', { class: 'status-brand', text: `提供 ${BRAND.companyName}` }),
  ]);

  root.appendChild(h('div', { class: 'app-shell' }, [header, main, status]));
  return { header, tabs, badge, canvasHost, side, bottom, status, statusText, openDataBtn };
}

/**
 * 規格値判定パネル。
 * 国土交通省「３次元計測技術を用いた出来形管理要領（案）」様式-31-2 の並びに合わせる。
 * 見慣れない様式だと受け取ってもらえないので、項目名と順序は様式どおりにする。
 */
export function judgementPanel(config) {
  const sheet = config.sheet;
  if (!sheet) return legacyJudgementPanel(config);

  const children = [];
  children.push(h('div', { class: 'sheet-head' }, [
    h('span', { class: 'sheet-form', text: sheet.form }),
    h('span', { class: `sheet-verdict ${sheet.pass ? 'ok' : 'ng'}`, text: sheet.verdict }),
  ]));
  children.push(h('div', { class: 'sheet-meta', text: `${sheet.workTypeName}　測定項目: ${sheet.measureName}` }));
  if (!sheet.measureIsOfficial) {
    children.push(h('p', { class: 'warn', text:
      `測定項目「${sheet.measureName}」は要領に定めのない方式です。検査には標高較差または水平較差を使用してください。` }));
  }

  for (const p of sheet.parts) {
    const rows = p.rows.map((r) => h('tr', { class: r.pass ? '' : 'ng' }, [
      h('td', { text: r.label }),
      h('td', { class: 'num', text: Number.isFinite(r.value) ? r.value.toFixed(r.unit === '点' ? 0 : 1) : '—' }),
      h('td', { class: 'unit', text: r.unit }),
      h('td', { class: 'num tol', text: `${r.tolerance.min ?? '—'} 〜 ${r.tolerance.max ?? '—'}` }),
      h('td', { class: `verdict ${r.pass ? 'ok' : 'ng'}`, text: r.pass ? '合格' : '規格値外' }),
    ]));
    children.push(h('div', { class: 'part-block' }, [
      h('div', { class: 'part-title' }, [
        h('span', { text: p.name }),
        h('span', { class: `part-verdict ${p.pass ? 'ok' : 'ng'}`, text: p.pass ? '合格' : '規格値外' }),
      ]),
      h('table', { class: 'judge-table' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: '測定項目' }), h('th', { class: 'num', text: '算出結果' }),
          h('th', { text: '単位' }), h('th', { class: 'num', text: '規格値' }), h('th', { text: '判定' }),
        ])]),
        h('tbody', {}, rows),
      ]),
      h('div', { class: 'spread' }, [
        spreadBar('規格値±50%以内', p.spread.within50Ratio, p.spread.within50Count),
        spreadBar('規格値±80%以内', p.spread.within80Ratio, p.spread.within80Count),
      ]),
      h('div', { class: 'part-foot', text:
        `評価点 ${p.evaluatedCount.toLocaleString()}　棄却点 ${p.outlierCount.toLocaleString()}`
        + `　評価面積 ${Number.isFinite(p.areaM2) ? p.areaM2.toFixed(0) : '—'} m²` }),
    ]));
  }

  for (const n of sheet.notes ?? []) children.push(h('p', { class: 'note-small', text: `※ ${n}` }));
  if (config.specSource && config.specSource.verified !== true) {
    children.push(h('p', { class: 'warn', text:
      `※ 規格値の出典が未確認です（${config.specSource.title ?? ''}）。検査に使う前に、適用される施工管理基準の値へ差し替えてください。` }));
  }
  return section('規格値判定', children, { open: true });
}

function spreadBar(label, ratio, count) {
  const pct = Number.isFinite(ratio) ? ratio : 0;
  return h('div', { class: 'spread-row' }, [
    h('span', { class: 'spread-label', text: label }),
    h('span', { class: 'spread-track' }, [h('span', { class: 'spread-fill', style: `width:${pct.toFixed(1)}%` })]),
    h('span', { class: 'spread-value', text: `${pct.toFixed(1)}%` }),
    h('span', { class: 'spread-count', text: `${(count ?? 0).toLocaleString()} 点` }),
  ]);
}

/** 旧形式（単一リスト）の判定表。取り込み時など sheet が無い場合の表示。 */
function legacyJudgementPanel(config) {
  const j = config.judgement;
  if (!j) return section('規格値判定', [h('p', { class: 'muted', text: '判定結果がありません。' })]);
  const rows = j.results.map((r) => h('tr', { class: r.pass ? '' : 'ng' }, [
    h('td', { text: r.label }),
    h('td', { class: 'num', text: Number.isFinite(r.value) ? r.value.toFixed(1) : '—' }),
    h('td', { class: 'unit', text: r.unit }),
    h('td', { class: 'num tol', text: `${r.tolerance.min ?? '—'} 〜 ${r.tolerance.max ?? '—'}` }),
    h('td', { class: `verdict ${r.pass ? 'ok' : 'ng'}`, text: r.pass ? '合格' : '不合格' }),
  ]));
  return section('規格値判定', [
    h('table', { class: 'judge-table' }, [
      h('thead', {}, [h('tr', {}, ['項目', '測定値', '単位', '規格値', '判定'].map((t) => h('th', { text: t })))]),
      h('tbody', {}, rows),
    ]),
  ], { open: true });
}

export function histogramPanel(config, rangeM) {
  const host = h('div', { class: 'hist-host', id: 'hist-host' });
  return { el: section('較差のヒストグラム', [host, h('div', { class: 'hist-legend', id: 'hist-legend' })], { open: true }), host };
}

export function renderHistogram(host, hist, rangeM, toleranceM) {
  const W = 300, H = 132, padL = 8, padR = 8, padT = 8, padB = 22;
  const counts = hist.counts;
  const max = Math.max(1, ...counts);
  const bw = (W - padL - padR) / counts.length;
  const parts = [];
  for (let i = 0; i < counts.length; i++) {
    const lo = hist.range[0] + (i / counts.length) * (hist.range[1] - hist.range[0]);
    const mid = lo + (hist.range[1] - hist.range[0]) / counts.length / 2;
    const bh = (counts[i] / max) * (H - padT - padB);
    parts.push(`<rect x="${(padL + i * bw).toFixed(2)}" y="${(H - padB - bh).toFixed(2)}" width="${Math.max(0.6, bw - 0.4).toFixed(2)}" height="${bh.toFixed(2)}" fill="${deviationCss(mid, rangeM)}"/>`);
  }
  const xOf = (v) => padL + ((v - hist.range[0]) / (hist.range[1] - hist.range[0])) * (W - padL - padR);
  for (const t of [-toleranceM, 0, toleranceM]) {
    if (t < hist.range[0] || t > hist.range[1]) continue;
    const x = xOf(t);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${H - padB}" stroke="${t === 0 ? '#444c55' : '#c0392b'}" stroke-width="1" stroke-dasharray="${t === 0 ? '' : '4 3'}"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${H - padB + 14}" font-size="10" fill="#5a6470" text-anchor="middle">${(t * 1000).toFixed(0)}</text>`);
  }
  parts.push(`<text x="${W - padR}" y="${H - padB + 14}" font-size="10" fill="#8a929b" text-anchor="end">mm</text>`);
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;

  const total = counts.reduce((a, b) => a + b, 0) + hist.under + hist.over;
  document.getElementById('hist-legend').innerHTML =
    `範囲外（下） ${hist.under.toLocaleString()} 点　範囲外（上） ${hist.over.toLocaleString()} 点　` +
    `設計面外 ${hist.nan.toLocaleString()} 点　計 ${total.toLocaleString()} 点`;
}

export function deviationLegend(rangeM, measureName = null) {
  const stops = DEVIATION_STOPS.map(([t]) => `${rampCss(DEVIATION_STOPS, t)} ${(t * 100).toFixed(0)}%`).join(', ');
  return h('div', { class: 'legend' }, [
    measureName ? h('div', { class: 'legend-title', text: measureName }) : null,
    h('div', { class: 'legend-bar', style: `background: linear-gradient(to right, ${stops})` }),
    h('div', { class: 'legend-ticks' }, [
      h('span', { text: `−${(rangeM * 1000).toFixed(0)}` }),
      h('span', { text: '0' }),
      h('span', { text: `+${(rangeM * 1000).toFixed(0)} mm` }),
    ]),
    h('div', { class: 'legend-note', text: '正（赤）= 設計面より上・外側／負（青）= 設計面より下・内側' }),
  ]);
}

export function classLegend() {
  const items = [2, 11, 3, 4, 5, 6, 7, 9].map((k) => h('div', { class: 'class-item' }, [
    h('span', { class: 'swatch', style: `background:rgb(${CLASS_COLORS[k].map((v) => Math.round(v * 255)).join(',')})` }),
    h('span', { text: CLASS_NAMES[k] ?? `分類 ${k}` }),
  ]));
  return h('div', { class: 'class-legend' }, items);
}

export function section(title, children, { open = false } = {}) {
  const body = h('div', { class: 'panel-body' }, children);
  const el = h('div', { class: `panel ${open ? 'open' : ''}` }, [
    h('button', { class: 'panel-head', text: title, onclick: () => el.classList.toggle('open') }),
    body,
  ]);
  return el;
}

export function bootError({ reason, detail, howto }) {
  return `<div class="boot-error">
    <h1>${reason}</h1>
    <p>${detail}</p>
    <ul>${howto.map((s) => `<li>${s}</li>`).join('')}</ul>
    <p class="fallback-note">3D 表示は使えませんが、平面図・断面図・較差カラーマップ・帳票は下に表示しています。</p>
  </div>`;
}

/**
 * スケールバーの更新。平面図では距離が読めないと地図として使えない。
 * @param worldPerPixel 画面 1px あたりの現地距離 (m)
 */
export function updateScalebar(worldPerPixel) {
  const el = document.getElementById('scalebar');
  if (!el) return;
  if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) { el.classList.remove('show'); return; }
  // 「切りの良い長さ」になるようバーの幅を決める（1,2,5 の系列）
  const targetPx = 120;
  const raw = worldPerPixel * targetPx;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  const nice = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * base;
  const px = nice / worldPerPixel;
  const label = nice >= 1000 ? `${(nice / 1000).toFixed(nice % 1000 ? 1 : 0)} km` : `${nice >= 1 ? nice : nice.toFixed(2)} m`;
  el.innerHTML = `<div style="text-align:center">${label}</div><div class="scalebar-bar" style="width:${px.toFixed(1)}px"></div>`;
  el.classList.add('show');
}

/** 画面ごとの操作方法を出す。3D は書いていないと分からない。 */
export function setControlsHint(mode) {
  const el = document.getElementById('controls-hint');
  if (!el) return;
  const rows = mode === '3d'
    ? [['左ドラッグ', '回転'], ['右ドラッグ', '平行移動'], ['ホイール', '拡大・縮小']]
    : [['ドラッグ', '平行移動'], ['ホイール', '拡大・縮小']];
  el.innerHTML = rows.map(([k, v]) =>
    `<span class="ch-row"><b>${k}</b>${v}</span>`).join('');
  el.classList.add('show');
}
