/**
 * エントリポイント。window.Tengun.start(config, rootElement) を公開する。
 *
 * 初期表示は「平面図 + 較差カラーマップ」。3D は見たい人が切り替えて見るもの。
 */
import './style.css';
import { TinSurface, extractSection, sectionSvg, planeToLl, toDms } from '@tengun/core';
import { probeWebGL2 } from './webgl.js';
import { Dataset, loadDesign } from './data.js';
import { Viewer3D, MODE } from './viewer3d.js';
import { Fallback2D } from './fallback.js';
import { deviationCss } from './colors.js';
import { createImportPanel } from './import/panel.js';
import {
  h, buildLayout, judgementPanel, histogramPanel, renderHistogram,
  deviationLegend, classLegend, section, bootError, updateScalebar,
} from './ui.js';

const COLOR_MODES = [
  { id: 'deviation', label: '設計との較差（判定に使う方式）', mode: MODE.DEVIATION },
  { id: 'deviationAlt', label: '設計との較差（法線方向・参考）', mode: MODE.DEVIATION, alt: true },
  { id: 'elevation', label: '標高', mode: MODE.ELEVATION },
  { id: 'rgb', label: 'RGB（実写色）', mode: MODE.RGB },
  { id: 'intensity', label: '反射強度', mode: MODE.INTENSITY },
  { id: 'classification', label: 'クラス分類', mode: MODE.CLASSIFICATION },
];

async function start(config, root) {
  const gl = probeWebGL2();
  const ui = buildLayout(root, config);
  const state = {
    config, gl,
    colorMode: 'deviation',
    rangeM: config.defaults.colorRangeM,
    toleranceM: config.defaults.toleranceM,
    pickA: null, pickB: null,
    picking: false,
    designTin: null,
    view: 'plan',
  };

  // ---- データ読み込み ----
  const baseUrl = '';
  const datasets = [];
  for (const d of config.datasets) {
    const inlineB64 = typeof config.inline?.datasets?.[d.id] === 'string' ? config.inline.datasets[d.id] : null;
    const inlineBytes = inlineB64 ? null : (config.inline?.datasets?.[d.id] ?? null);
    datasets.push(new Dataset(d, { baseUrl, inlineB64, inlineBytes }));
  }
  if (!datasets.length) {
    ui.canvasHost.innerHTML = '<div class="boot-error"><h1>点群データがありません</h1><p>変換が正しく完了していない可能性があります。</p></div>';
    return;
  }

  let design = null;
  try {
    const dInline = config.inline?.design ?? null;
    design = await loadDesign(config.design, {
      baseUrl,
      inlineB64: typeof dInline === 'string' ? dInline : null,
      inlineBytes: typeof dInline === 'string' ? null : dInline,
    });
  } catch (e) {
    console.warn('設計データを読めませんでした', e);
  }
  if (design) {
    // 断面図に設計線を重ねるため、ビューア側でも TIN を持つ（計算は core に閉じている）
    const nv = design.vertexCount;
    const e = new Float64Array(nv), n = new Float64Array(nv), hh = new Float64Array(nv);
    const do_ = config.design.origin, po = config.origin ?? do_;
    for (let i = 0; i < nv; i++) {
      e[i] = design.pos[i * 3] + do_[0] - po[0];
      n[i] = design.pos[i * 3 + 1] + do_[1] - po[1];
      hh[i] = design.pos[i * 3 + 2] + do_[2] - po[2];
    }
    // 点群と同じローカル原点に合わせてから TIN を組む
    state.designTin = new TinSurface({ e, n, h: hh, faces: new Int32Array(design.idx), name: '設計面' });
    state.designLocal = { pos: shiftDesign(design.pos, do_, po), idx: design.idx, vertexCount: nv, triangleCount: design.triangleCount };
  }

  // ---- 表示エンジン ----
  let engine = null;
  if (gl.ok) {
    engine = new Viewer3D(ui.canvasHost, { defaults: config.defaults });
    for (const ds of datasets) engine.addDataset(ds);
    engine.setDesign(state.designLocal);
    engine.setDesignVisible(false);
    engine.frameAll();
    engine.start();
    engine.onStatus = (s) => {
      updateStatus(ui.status, s, gl, config);
      updateScalebar(engine.worldPerPixel());
      document.getElementById('north')?.classList.toggle('show', engine.mode === 'plan');
    };
  } else {
    const note = h('div', { class: 'gl-warning', html: bootError(gl) });
    note.appendChild(h('button', {
      class: 'gl-dismiss', text: '閉じる', onclick: () => note.remove(),
    }));
    ui.canvasHost.appendChild(note);
    engine = new Fallback2D(ui.canvasHost, { defaults: config.defaults });
    // 2D モードでは先頭ノードから順に読めるだけ読む
    const ds = datasets[0];
    const chunks = [];
    let acc = 0;
    for (const node of ds.hierarchy.nodes) {
      if (acc > 1_200_000) break;
      try {
        const nd = ds.byName.get(node.name);
        chunks.push(ds.decode(await ds.fetchNode(nd), nd));
        acc += node.pointCount;
      } catch (e) { break; }
    }
    engine.setPoints(chunks);
    updateStatus(ui.status, { loadedPoints: acc, visibleNodes: chunks.length, pending: 0, fps: 0, memory: null }, gl, config);
    const sync2d = () => {
      updateScalebar(1 / engine.view.scale);
      document.getElementById('north')?.classList.add('show');
    };
    sync2d();
    const origDraw = engine.draw.bind(engine);
    engine.draw = () => { origDraw(); sync2d(); };
  }

  // ---- 右パネル ----
  const hist = histogramPanel(config, state.rangeM);
  const legendHost = h('div', {}, [deviationLegend(state.rangeM)]);

  const colorSelect = h('select', {
    class: 'select', onchange: (e) => setColorMode(e.target.value),
  }, COLOR_MODES.map((m) => h('option', { value: m.id, text: m.label })));

  const rangeInput = h('input', {
    type: 'range', min: '5', max: '300', step: '5', value: String(state.rangeM * 1000),
    class: 'slider', oninput: (e) => setRange(Number(e.target.value) / 1000),
  });
  const rangeLabel = h('span', { class: 'slider-value', text: `±${(state.rangeM * 1000).toFixed(0)} mm` });

  const sizeInput = h('input', {
    type: 'range', min: '1', max: '10', step: '0.5', value: '2', class: 'slider',
    oninput: (e) => { const v = Number(e.target.value); engine.setPointSize ? engine.setPointSize(v) : (engine.pointSize = v, engine.draw()); },
  });

  const densityInput = h('input', {
    type: 'range', min: '1', max: '100', step: '1', value: '100', class: 'slider',
    oninput: (e) => setDensity(Number(e.target.value) / 100),
  });

  const highlight = h('input', { type: 'checkbox', onchange: (e) => engine.setHighlightOut?.(e.target.checked) });
  const designToggle = h('input', { type: 'checkbox', onchange: (e) => engine.setDesignVisible?.(e.target.checked) });

  const datasetSelect = datasets.length > 1
    ? h('select', { class: 'select', onchange: (e) => engine.setActiveDataset?.(e.target.value) },
        datasets.map((d) => h('option', { value: d.id, text: d.label })))
    : null;

  const displayPanel = section('表示', [
    ...(datasetSelect ? [field('点群', datasetSelect)] : []),
    field('色分け', colorSelect),
    field('色域', h('div', { class: 'slider-row' }, [rangeInput, rangeLabel])),
    field('点サイズ', sizeInput),
    field('点密度', densityInput),
    checkboxField('規格値内を淡色にする', highlight),
    ...(state.designLocal && gl.ok ? [checkboxField('設計面を重ねる', designToggle)] : []),
    legendHost,
  ], { open: true });

  ui.side.appendChild(judgementPanel(config));
  ui.side.appendChild(displayPanel);
  ui.side.appendChild(hist.el);
  ui.side.appendChild(sectionPanel());
  ui.side.appendChild(reportPanel(config));
  ui.side.appendChild(buildImportPanel());
  ui.side.appendChild(diagnosticsPanel(config, gl));

  renderHistogram(hist.host, config.histogram, state.rangeM, state.toleranceM);
  if (gl.ok) engine.setColorMode(MODE.DEVIATION);

  // ---- タブ ----
  ui.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    for (const t of ui.tabs.querySelectorAll('.tab')) t.classList.toggle('active', t === b);
    setView(b.dataset.view);
  });

  setView('plan');
  updateHint();

  // ---- 座標表示 ----
  ui.canvasHost.addEventListener('mouseleave', () => {
    document.getElementById('readout')?.classList.remove('show');
  });
  ui.canvasHost.addEventListener('mousemove', (e) => {
    const p = gl.ok ? engine.screenToWorld(e.clientX, e.clientY) : screenToWorld2D(engine, ui.canvasHost, e);
    const el = document.getElementById('readout');
    if (!p) { el.textContent = ''; el.classList.remove('show'); return; }
    el.classList.add('show');
    const o = config.origin ?? [0, 0, 0];
    const E = p.x + o[0], N = p.y + o[1];
    let ll = '';
    try {
      const g = planeToLl(E, N, config.info.epsg);
      ll = `　${toDms(g.lat, true)} ${toDms(g.lon, false)}`;
    } catch { /* 平面直角座標系でなければ出さない */ }
    el.textContent = `X(北) ${N.toFixed(3)}　Y(東) ${E.toFixed(3)}${ll}`;
  });

  ui.canvasHost.addEventListener('click', (e) => {
    if (!state.picking) return;
    const p = gl.ok ? engine.screenToWorld(e.clientX, e.clientY) : screenToWorld2D(engine, ui.canvasHost, e);
    if (!p) return;
    if (!state.pickA) {
      state.pickA = p; state.pickB = null;
      updateHint('測線の終点をクリックしてください');
    } else {
      state.pickB = p;
      state.picking = false;
      drawSection();
      updateHint();
    }
    if (gl.ok) engine.drawLineOverlay(state.pickA, state.pickB);
    else { engine.line = state.pickA && state.pickB ? { a: state.pickA, b: state.pickB } : null; engine.draw(); }
  });

  // ---------- 関数 ----------
  function field(label, control) {
    return h('div', { class: 'field' }, [h('label', { text: label }), control]);
  }
  function checkboxField(label, input) {
    return h('label', { class: 'check' }, [input, h('span', { text: label })]);
  }

  function setColorMode(id) {
    state.colorMode = id;
    const m = COLOR_MODES.find((x) => x.id === id);
    if (gl.ok) { engine.setColorMode(m.mode); engine.setUseAltMeasure(!!m.alt); }
    else { engine.mode = m.alt ? 'deviationAlt' : id; engine.draw(); }
    legendHost.innerHTML = '';
    if (m.mode === MODE.DEVIATION) {
      const name = m.alt ? '法線方向較差（参考・要領外）' : (config.measure?.name ?? '較差');
      legendHost.appendChild(deviationLegend(state.rangeM, name));
    } else if (id === 'classification') legendHost.appendChild(classLegend());
    if (state.pickA && state.pickB) drawSection();
  }

  function setRange(v) {
    state.rangeM = v;
    rangeLabel.textContent = `±${(v * 1000).toFixed(0)} mm`;
    if (gl.ok) engine.setDevRange(v); else { engine.rangeM = v; engine.draw(); }
    if (state.colorMode === 'deviation') { legendHost.innerHTML = ''; legendHost.appendChild(deviationLegend(v)); }
    renderHistogram(hist.host, config.histogram, v, state.toleranceM);
    if (state.pickA && state.pickB) drawSection();
  }

  function setDensity(f) {
    if (!gl.ok) return;
    for (const entry of engine.datasets.values()) {
      for (const [name, obj] of entry.objects) {
        const node = entry.ds.byName.get(name);
        obj.geometry.setDrawRange(0, Math.max(1, Math.floor(node.pointCount * f)));
      }
    }
  }

  function setView(v) {
    state.view = v;
    const bottom = document.getElementById('bottom');
    if (v === 'section') {
      state.picking = true; state.pickA = null; state.pickB = null;
      if (gl.ok) { engine.setViewMode('plan'); engine.drawLineOverlay(null, null); }
      bottom.classList.add('show');
      bottom.innerHTML = '<div class="section-empty">平面図上で 2 点をクリックすると、その測線の縦断図を作ります。</div>';
      updateHint('測線の始点をクリックしてください');
    } else {
      state.picking = false;
      if (gl.ok) engine.setViewMode(v === '3d' ? '3d' : 'plan');
      bottom.classList.toggle('show', !!(state.pickA && state.pickB));
      updateHint();
    }
  }

  function updateHint(msg) {
    const el = document.getElementById('view-hint');
    if (msg) { el.textContent = msg; el.classList.add('show'); return; }
    el.classList.remove('show');
    el.textContent = '';
  }

  function drawSection() {
    const bottom = document.getElementById('bottom');
    bottom.classList.add('show');
    const gathered = engine.gatherAlongLine(state.pickA, state.pickB, 0.5);
    if (!gathered.count) {
      bottom.innerHTML = '<div class="section-empty">この測線上に点がありません。別の場所で引き直してください。</div>';
      return;
    }
    const sec = extractSection(
      { count: gathered.count, e: gathered.e, n: gathered.n, h: gathered.h, deviation: gathered.deviation },
      state.designTin,
      { e1: state.pickA.x, n1: state.pickA.y, e2: state.pickB.x, n2: state.pickB.y },
      { halfWidth: 0.5 }
    );
    // 内部はローカル原点基準で計算している。図には現地標高で出さないと帳票にならない。
    const hOffset = (config.origin ?? [0, 0, 0])[2];
    for (const p of sec.points) p.h += hOffset;
    for (const d of sec.design) if (d.h !== null) d.h += hOffset;
    const svg = sectionSvg(sec, {
      width: Math.max(640, bottom.clientWidth - 24), height: 240,
      title: '縦断図（クリックした 2 点を結ぶ測線）',
      colorScale: (d) => deviationCss(d, state.rangeM),
    });
    bottom.innerHTML = '';
    bottom.appendChild(h('div', { class: 'section-head' }, [
      h('span', { text: `延長 ${sec.length.toFixed(2)} m　抽出点数 ${sec.points.length.toLocaleString()}（測線から ±0.5m）` }),
      h('button', { class: 'btn small', text: 'SVG を保存', onclick: () => downloadText('断面図.svg', svg, 'image/svg+xml') }),
      h('button', { class: 'btn small', text: '引き直す', onclick: () => { state.picking = true; state.pickA = null; state.pickB = null; updateHint('測線の始点をクリックしてください'); } }),
    ]));
    bottom.appendChild(h('div', { class: 'section-svg', html: svg }));
  }

  function sectionPanel() {
    const rows = (config.sections ?? []).map((s) => h('tr', { class: s.pass ? '' : 'ng' }, [
      h('td', { text: s.label }),
      h('td', { class: 'num', text: s.stats.count?.toLocaleString() ?? '—' }),
      h('td', { class: 'num', text: fmtMm(s.stats.mean) }),
      h('td', { class: 'num', text: fmtMm(s.stats.stddev) }),
      h('td', { class: `verdict ${s.pass ? 'ok' : 'ng'}`, text: s.pass ? '合格' : '不合格' }),
    ]));
    if (!rows.length) return section('横断測点', [h('p', { class: 'muted', text: '横断測点の集計がありません。' })]);
    return section('横断測点（20m 間隔）', [
      h('table', { class: 'judge-table compact' }, [
        h('thead', {}, [h('tr', {}, ['測点', '点数', '平均(mm)', 'σ(mm)', '判定'].map((t) => h('th', { text: t })))]),
        h('tbody', {}, rows),
      ]),
    ]);
  }

  function buildImportPanel() {
    const panel = createImportPanel({
      workTypes: config.specSource ? null : null,
      onLoaded: ({ config: newConfig, inline }) => {
        // 取り込んだデータで画面ごと作り直す。描画パスは変換済みデータと同じものを通す。
        newConfig.inline = inline;
        engine.dispose?.();
        start(newConfig, root).catch((e) => console.error(e));
      },
    });
    // 画面全体をドロップ先にする（右パネルまでドラッグさせない）
    for (const ev of ['dragenter', 'dragover']) root.addEventListener(ev, (e) => e.preventDefault());
    root.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      panel.el.classList.add('open');
      panel.el.scrollIntoView({ block: 'nearest' });
      panel.accept([...e.dataTransfer.files]);
    });
    return panel.el;
  }

  function reportPanel(cfg) {
    const items = (cfg.reports ?? []).map((r) => {
      if (r.url) return h('a', { class: 'btn', href: r.url, download: r.label, text: r.label });
      const text = cfg.inline?.reports?.[r.inline];
      return h('button', { class: 'btn', text: r.label, onclick: () => downloadText(r.label, text, 'text/csv') });
    });
    if (cfg.mode === 'light') {
      items.push(h('p', { class: 'muted', text: '軽量版では点が間引かれています。判定値は CSV の値を正としてください。' }));
    }
    return section('帳票', items.length ? items : [h('p', { class: 'muted', text: '帳票がありません。' })]);
  }

  function diagnosticsPanel(cfg, glInfo) {
    const rows = [
      ['ビューア', cfg.generator ?? '—'],
      ['生成日時', cfg.builtAt ? new Date(cfg.builtAt).toLocaleString('ja-JP') : '—'],
      ['配布形態', cfg.mode === 'light' ? '軽量版（単一 HTML / file:// 可）' : 'フル版（Web サーバ配置）'],
      ['座標系', cfg.info.crsLabel ?? '—'],
      ['WebGL2', glInfo.ok ? '利用可' : '利用不可（2D モード）'],
      ['描画装置', glInfo.ok ? glInfo.renderer : '—'],
      ['ソフトウェア描画', glInfo.ok ? (glInfo.software ? 'はい（動作が遅くなります）' : 'いいえ') : '—'],
      ['総点数', cfg.datasets.reduce((s, d) => s + (d.pointCount ?? 0), 0).toLocaleString()],
      ['判定の測定項目', cfg.measure?.name ?? cfg.sheet?.measureName ?? '—'],
      ['法面の判定勾配', cfg.parts?.slopeThresholdDeg !== undefined ? `${cfg.parts.slopeThresholdDeg}° 以上` : '—'],
    ];
    if (cfg.site?.center) rows.push(['現場中心', cfg.site.center.label]);
    if (cfg.specSource?.title) rows.push(['規格値定義', `${cfg.specSource.title}${cfg.specSource.verified ? '' : '（出典未確認）'}`]);
    return section('診断情報', [
      h('dl', { class: 'stat-list' }, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])),
      h('button', { class: 'btn', text: '診断情報をコピー', onclick: () => {
        navigator.clipboard?.writeText(rows.map((r) => `${r[0]}: ${r[1]}`).join('\n'));
      } }),
    ]);
  }
}

function shiftDesign(pos, from, to) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length / 3; i++) {
    out[i * 3] = pos[i * 3] + from[0] - to[0];
    out[i * 3 + 1] = pos[i * 3 + 1] + from[1] - to[1];
    out[i * 3 + 2] = pos[i * 3 + 2] + from[2] - to[2];
  }
  return out;
}

function screenToWorld2D(engine, host, e) {
  const rect = host.getBoundingClientRect();
  return engine.toWorld(e.clientX - rect.left, e.clientY - rect.top);
}

function fmtMm(v) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : (v * 1000).toFixed(1);
}

function downloadText(name, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function updateStatus(el, s, gl, config) {
  const mem = s.memory ? `　メモリ ${s.memory.usedMB} / ${s.memory.limitMB} MB` : '';
  const fps = s.fps ? `　${s.fps.toFixed(0)} fps` : '';
  el.textContent =
    `読み込み済み ${s.loadedPoints.toLocaleString()} 点　表示ノード ${s.visibleNodes}` +
    `${s.pending ? `　読み込み中 ${s.pending}` : ''}${fps}${mem}` +
    `　${gl.ok ? 'WebGL2' : '2D モード'}`;
}

window.Tengun = {
  start(config, root) {
    start(config, root).catch((err) => {
      console.error(err);
      root.innerHTML = `<div class="boot-error"><h1>読み込みに失敗しました</h1><p>${String(err.message ?? err)}</p></div>`;
    });
  },
};
