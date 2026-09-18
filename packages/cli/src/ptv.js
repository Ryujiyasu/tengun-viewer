#!/usr/bin/env node
/**
 * ptv — 点群変換とパッケージ生成の CLI
 *
 *   ptv build --post 出来形.las --design 設計.xml --info 工事情報.json \
 *             [--pre 起工測量.las] [--profile full|light] --out ./dist/工事番号/
 *
 * full  : octree 分割した静的ファイル群（閉域 Web サーバ配置用）
 * light : 間引いた点群を埋め込んだ単一 HTML（file:// でそのまま開く用）
 */
import { readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  parseLandXml, TinSurface, computeDeviations, deviationStats, histogram,
  loadSpec, judge, buildOctree, serializeOctree, decimateForLight, subsetPoints,
  judgementCsv, histogramCsv, buildManifest, describeCrs, planeToLl, toDms,
  extractSection, sectionSvg, crossSectionLines, toCsv, serializeTin,
  MEASURES, computeElevationDeviations, computeHorizontalDeviations, classifyParts,
  horizontalArea, buildSheet, sheetCsv,
} from '@tengun/core';

import { parseArgs } from './args.js';
import { readPointFile, applyAxisOrder } from './read-points.js';
import { loadViewerAssets, renderIndexHtml, toBase64 } from './package-html.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const GENERATOR = 'tengun ptv 0.1.0';
// JSON を <script> に埋める際に潰す必要がある文字（U+2028/U+2029 は JS では改行扱い）
const SEP_RE = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

const USAGE = `
ptv build — 点群と設計データからビューア一式を生成する

  必須
    --post    <file>   出来形評価用点群 (LAS/LAZ)
    --design  <file>   3次元設計データ (LandXML 1.2 TIN)
    --info    <file>   工事情報 JSON
    --out     <dir>    出力先ディレクトリ

  任意
    --pre     <file>   起工測量点群 (LAS/LAZ)。差分の基準面として同梱する
    --profile full|light|both   既定 both
    --spec    <file>   規格値定義 JSON（既定 docs/spec-values.json）
    --max-distance <m> 設計面から離れすぎた点を評価外にする距離（既定 5）
    --light-points <n> light プロファイルの目標点数（既定 1200000）
    --section-interval <m>  横断図の測点間隔（既定 20）
    --measure <id>     判定に使う較差の方式 elevation|horizontal|normal（既定 elevation）
    --work-type <id>   規格値定義の工種 id（既定は工事情報の workType）
    --slope-threshold <deg>  法面とみなす勾配（既定 15）
    --skip-normal      表示用の法線方向較差を計算しない（変換を速くする）
    --ground-only      地表面(class 2,11)のみ判定に使う（既定 有効）
    --all-classes      分類によらず全点を判定に使う
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.help) { console.log(USAGE); process.exit(cmd ? 0 : 1); }
  if (cmd !== 'build') { console.error(`未知のコマンド: ${cmd}\n${USAGE}`); process.exit(1); }

  for (const req of ['post', 'design', 'info', 'out']) {
    if (!args[req]) { console.error(`--${req} は必須です\n${USAGE}`); process.exit(1); }
  }

  const T = new Timer();
  const log = (s) => console.log(s);

  // ---- 工事情報 ----
  const info = JSON.parse(await readFile(args.info, 'utf8'));
  if (!info.epsg) {
    throw new Error('工事情報に epsg がありません。LAS ヘッダには座標系が入っていないことが多いので、推測せず明示指定してください。');
  }
  info.crsLabel = describeCrs(info.epsg);
  const axisOrder = info.axisOrder ?? 'EN';

  log(`工事名   ${info.projectName ?? '(未設定)'}`);
  log(`座標系   ${info.crsLabel}  / LAS 軸並び ${axisOrder}`);

  // ---- 規格値定義 ----
  const specPath = args.spec ?? join(REPO, 'docs', 'spec-values.json');
  const spec = loadSpec(await readFile(specPath, 'utf8'));
  const workTypeId = args['work-type'] ?? info.workType ?? spec.workTypes[0].id;
  const workType = spec.workTypes.find((w) => w.id === workTypeId);
  if (!workType) {
    throw new Error(`工種 "${workTypeId}" が規格値定義にありません。利用できるのは: ${spec.workTypes.map((w) => w.id).join(', ')}`);
  }
  const toleranceM = workType.toleranceM ?? spec.defaults?.toleranceM ?? 0.05;
  if (spec.source?.verified !== true) {
    log(`⚠ 規格値定義 ${basename(specPath)} は出典未確認です。検査に使う前に最新の要領の値へ差し替えてください。`);
  }

  // ---- 設計 TIN ----
  T.mark('design');
  log(`\n設計データを読み込み中… ${basename(args.design)}`);
  const designRaw = await readFile(args.design);
  const designDoc = parseLandXml(designRaw.toString('utf8'), { pointOrder: info.design?.pointOrder ?? 'NEH' });
  const surf = designDoc.surfaces[0];
  const tin = new TinSurface({ e: surf.e, n: surf.n, h: surf.h, faces: surf.faces, name: surf.name });
  log(`  サーフェス「${surf.name}」 節点 ${surf.pointCount.toLocaleString()} / 三角形 ${tin.triCount.toLocaleString()} / 面積 ${tin.surfaceArea.toFixed(0)} m²`);
  if (designDoc.coordinateSystem?.epsgCode && Number(designDoc.coordinateSystem.epsgCode) !== Number(info.epsg)) {
    log(`⚠ LandXML の epsgCode (${designDoc.coordinateSystem.epsgCode}) と工事情報の epsg (${info.epsg}) が一致しません。`);
  }
  T.done('design');

  // ---- 出来形点群 ----
  T.mark('read-post');
  log(`\n出来形点群を読み込み中… ${basename(args.post)}`);
  const postFile = await readPointFile(args.post, { onLog: log });
  applyAxisOrder(postFile.points, axisOrder);
  log(`  ${postFile.points.count.toLocaleString()} 点 / LAS ${postFile.header.version} / フォーマット ${postFile.header.pointDataRecordFormat}${postFile.header.hasColor ? '（RGB あり）' : '（RGB なし）'}`);
  T.done('read-post');
  checkOverlap(postFile.points, tin, log);

  // ---- 較差計算 ----
  // 判定に使うのは要領が定める方式（既定: 標高較差）。
  // 法線方向較差は要領に無いので、表示用の副次データとして併せて持つ。
  T.mark('deviation');
  const maxDistance = Number(args['max-distance'] ?? spec.defaults?.maxDistanceM ?? 5);
  const measureId = args.measure ?? workType.measure ?? spec.defaults?.measure ?? 'elevation';
  const measure = MEASURES[measureId];
  if (!measure) {
    throw new Error(`--measure は ${Object.keys(MEASURES).join(' / ')} のいずれかです: ${measureId}`);
  }
  if (!measure.official) {
    log(`⚠ 測定項目「${measure.name}」は要領に定めのない方式です。検査には標高較差または水平較差を使ってください。`);
  }

  log(`\n${measure.name}を計算中…`);
  const primary = measureId === 'elevation'
    ? computeElevationDeviations(postFile.points, tin, { onProgress: progress(log) })
    : measureId === 'horizontal'
      ? computeHorizontalDeviations(postFile.points, tin, { onProgress: progress(log) })
      : computeDeviations(postFile.points, tin, { maxDistance, onProgress: progress(log) });
  postFile.points.deviation = primary.deviation;
  if (process.stdout.isTTY) process.stdout.write('\n');
  log(`  評価 ${primary.inRange.toLocaleString()} 点 / 評価対象外 ${primary.outOfRange.toLocaleString()} 点`);

  if (measureId !== 'normal' && !args['skip-normal']) {
    log(`表示用に法線方向較差も計算中…`);
    const alt = computeDeviations(postFile.points, tin, { maxDistance, onProgress: progress(log) });
    postFile.points.deviationAlt = alt.deviation;
    if (process.stdout.isTTY) process.stdout.write('\n');
  }
  T.done('deviation');

  // ---- 部位分け（天端 / 法面）----
  T.mark('parts');
  const slopeThresholdDeg = Number(args['slope-threshold'] ?? spec.defaults?.slopeThresholdDeg ?? 15);
  const { part, counts: partCounts } = classifyParts(postFile.points, tin, { slopeThresholdDeg });
  const areaByPart = {};
  for (const pdef of workType.parts ?? []) {
    const steep = pdef.slope === 'steep';
    areaByPart[pdef.id] = horizontalArea(tin, (ti) => (tin.slopeDeg(ti) >= slopeThresholdDeg) === steep);
  }
  log(`\n部位分け（勾配 ${slopeThresholdDeg}° 以上を法面とする）`);
  log(`  天端 ${partCounts.crest.toLocaleString()} 点 / 法面 ${partCounts.slope.toLocaleString()} 点 / 設計面外 ${partCounts.none.toLocaleString()} 点`);
  for (const [k, v] of Object.entries(areaByPart)) log(`  評価面積 ${k}: ${v.toFixed(0)} m²（水平投影）`);
  T.done('parts');

  // ---- 判定（様式-31-2）----
  const groundOnly = !args['all-classes'];
  const judgeDev = groundOnly
    ? filterByClass(primary.deviation, postFile.points.classification, [2, 11])
    : primary.deviation;
  const sheet = buildSheet(judgeDev, part, workType, { areaByPart });
  const stats = deviationStats(judgeDev, { withinToleranceM: toleranceM });

  log(`\n出来形合否判定総括表（${workType.name} / ${measure.name} / ${groundOnly ? '地表面のみ' : '全点'}）`);
  for (const pt of sheet.parts) {
    log(`  [${pt.name}]  評価 ${pt.evaluatedCount.toLocaleString()} 点 / 棄却 ${pt.outlierCount.toLocaleString()} 点`);
    for (const r of pt.rows) {
      log(`    ${r.pass ? '合格  ' : '規格値外'} ${r.label.padEnd(10, '　')} ${fmtNum(r.value).padStart(9)} ${r.unit}  規格値 ${fmtTol(r.tolerance)}`);
    }
    log(`    ばらつき  規格値±50%以内 ${pt.spread.within50Ratio.toFixed(1)}%  /  ±80%以内 ${pt.spread.within80Ratio.toFixed(1)}%`);
  }
  log(`  合否判定結果: ${sheet.verdict}`);

  // ---- 起工測量（任意） ----
  let preFile = null;
  if (args.pre) {
    T.mark('read-pre');
    log(`\n起工測量点群を読み込み中… ${basename(args.pre)}`);
    preFile = await readPointFile(args.pre, { onLog: log });
    applyAxisOrder(preFile.points, axisOrder);
    log(`  ${preFile.points.count.toLocaleString()} 点`);
    T.done('read-pre');
  }

  // ---- 出力 ----
  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });
  const profile = args.profile ?? 'both';
  const wantFull = profile === 'full' || profile === 'both';
  const wantLight = profile === 'light' || profile === 'both';

  const assets = await loadViewerAssets();
  const hist = histogram(judgeDev, { bins: 61, range: [-toleranceM * 1.4, toleranceM * 1.4] });

  // 横断測点ごとの集計と断面図
  T.mark('sections');
  const sections = buildSections(postFile.points, tin, {
    interval: Number(args['section-interval'] ?? 20),
    toleranceM, judgeGroundOnly: groundOnly,
  });
  T.done('sections');

  // 帳票
  const reports = {
    '出来形合否判定総括表.csv': sheetCsv(sheet, { info, toCsv }),
    'report.csv': judgementCsv({ info, judgement: legacyJudgement(sheet), stats, sections: sections.summary }),
    'histogram.csv': histogramCsv(judgeDev, { bins: 61, range: [-toleranceM * 1.4, toleranceM * 1.4] }),
  };
  if (preFile) reports['土量.csv'] = earthworkCsv(preFile.points, postFile.points, tin);

  const outputs = [];
  const processing = {
    generator: GENERATOR,
    designSurface: surf.name,
    triangleCount: tin.triCount,
    maxDistanceM: maxDistance,
    judgedClasses: groundOnly ? [2, 11] : 'all',
    toleranceM,
    measure: measureId,
    slopeThresholdDeg,
    specFile: basename(specPath),
    specVerified: spec.source?.verified === true,
    workType: workTypeId,
    pointCount: postFile.points.count,
    evaluatedPointCount: stats.count,
  };

  const designPayload = serializeTin(tin);
  const baseConfig = {
    generator: GENERATOR,
    builtAt: new Date().toISOString(),
    info: pickInfo(info),
    sheet,
    judgement: legacyJudgement(sheet),
    measure: { id: measureId, ...measure },
    stats: plainStats(stats),
    parts: { slopeThresholdDeg, counts: partCounts, areaByPart },
    histogram: { bins: hist.bins, range: hist.range, counts: Array.from(hist.counts), under: hist.under, over: hist.over, nan: hist.nan },
    defaults: { colorRangeM: spec.defaults?.colorRangeM ?? toleranceM, toleranceM },
    sections: sections.summary.map((s) => ({ label: s.label, station: s.station, line: s.line, stats: plainStats(s.stats), pass: s.pass })),
    origin: null,
    site: siteSummary(postFile.points, info),
    specSource: spec.source ?? null,
  };

  if (wantFull) {
    T.mark('full');
    log('\n[full] octree を構築中…');
    const fullDir = join(outDir, 'full');
    await mkdir(join(fullDir, 'data'), { recursive: true });
    await mkdir(join(fullDir, 'report'), { recursive: true });

    const datasets = [];
    for (const [id, label, file] of [['post', '出来形', postFile], ['pre', '起工測量', preFile]]) {
      if (!file) continue;
      const tree = buildOctree(file.points, { onProgress: progress(log, `  ${label}`) });
      if (process.stdout.isTTY) process.stdout.write('\n');
      const { bin, hierarchy } = serializeOctree(tree, file.points);
      await writeFile(join(fullDir, 'data', `${id}.bin`), bin);
      log(`  ${label}: ${hierarchy.nodes.length} ノード / ${hierarchy.pointCount.toLocaleString()} 点 / ${mb(bin.byteLength)}`);
      datasets.push({ id, label, url: `data/${id}.bin`, hierarchy, pointCount: hierarchy.pointCount });
      outputs.push({ file: `full/data/${id}.bin`, bytes: bin.byteLength, sha256: sha(bin), role: `${id}-octree` });
      if (baseConfig.origin === null) baseConfig.origin = hierarchy.origin;
    }

    await writeFile(join(fullDir, 'data', 'design.bin'), designPayload.bin);
    outputs.push({ file: 'full/data/design.bin', bytes: designPayload.bin.byteLength, sha256: sha(designPayload.bin), role: 'design-tin' });
    await writeFile(join(fullDir, 'viewer.js'), assets.js);
    await writeFile(join(fullDir, 'viewer.css'), assets.css);

    for (const [name, text] of Object.entries(reports)) {
      await writeFile(join(fullDir, 'report', name), text, 'utf8');
      outputs.push({ file: `full/report/${name}`, bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text)), role: 'report' });
    }
    for (const s of sections.svgs) {
      await writeFile(join(fullDir, 'report', s.file), s.svg, 'utf8');
    }

    const cfg = {
      ...baseConfig, mode: 'full',
      datasets: datasets.map((d) => ({ id: d.id, label: d.label, url: d.url, hierarchy: d.hierarchy, pointCount: d.pointCount })),
      design: { url: 'data/design.bin', vertexCount: designPayload.vertexCount, triangleCount: designPayload.triangleCount, origin: designPayload.origin },
      reports: Object.keys(reports).map((f) => ({ label: f, url: `report/${f}` })),
      external: { js: 'viewer.js', css: 'viewer.css' },
    };
    const html = renderIndexHtmlExternal(cfg, info);
    await writeFile(join(fullDir, 'index.html'), html, 'utf8');
    log(`  → ${fullDir}`);
    T.done('full');
  }

  if (wantLight) {
    T.mark('light');
    const target = Number(args['light-points'] ?? 1_200_000);
    log(`\n[light] 較差優先で ${target.toLocaleString()} 点に間引き中…`);
    const lightDir = join(outDir, 'light');
    await mkdir(lightDir, { recursive: true });

    const inline = { datasets: {}, design: null, reports: {} };
    const datasets = [];
    for (const [id, label, file] of [['post', '出来形', postFile], ['pre', '起工測量', preFile]]) {
      if (!file) continue;
      const budget = id === 'post' ? target : Math.round(target * 0.35);
      const dec = decimateForLight(file.points, budget);
      const sub = subsetPoints(file.points, dec.indices);
      log(`  ${label}: ${file.points.count.toLocaleString()} → ${sub.count.toLocaleString()} 点（${dec.strategy}）`);
      const tree = buildOctree(sub, { leafThreshold: 60000 });
      const { bin, hierarchy } = serializeOctree(tree, sub);
      inline.datasets[id] = toBase64(bin);
      datasets.push({ id, label, hierarchy, pointCount: hierarchy.pointCount, inline: true });
      if (baseConfig.origin === null) baseConfig.origin = hierarchy.origin;
    }
    inline.design = toBase64(designPayload.bin);
    for (const [name, text] of Object.entries(reports)) inline.reports[name] = text;

    const cfg = {
      ...baseConfig, mode: 'light',
      datasets,
      design: { inline: true, vertexCount: designPayload.vertexCount, triangleCount: designPayload.triangleCount, origin: designPayload.origin },
      reports: Object.keys(reports).map((f) => ({ label: f, inline: f })),
      note: 'file:// で開くための軽量版です。点は間引かれているため、判定値は帳票（CSV）の値を正としてください。',
    };
    const html = renderIndexHtml({ config: cfg, assets, inlineData: inline });
    const file = join(lightDir, 'index.html');
    await writeFile(file, html, 'utf8');
    const size = (await stat(file)).size;
    outputs.push({ file: 'light/index.html', bytes: size, sha256: sha(Buffer.from(html)), role: 'light-viewer' });
    log(`  → ${file}  ${mb(size)}`);
    if (size > 60 * 1024 * 1024) {
      log(`⚠ 単一 HTML が ${mb(size)} あります。ブラウザによっては開くのに時間がかかります。--light-points を下げてください。`);
    }
    T.done('light');
  }

  // ---- manifest ----
  const inputs = [
    { role: 'post', file: basename(args.post), bytes: postFile.bytes, sha256: postFile.sha256, pointCount: postFile.points.count, ...(info.acquisition?.post ?? {}) },
    { role: 'design', file: basename(args.design), bytes: designRaw.byteLength, sha256: sha(designRaw), pointCount: surf.pointCount },
  ];
  if (preFile) inputs.push({ role: 'pre', file: basename(args.pre), bytes: preFile.bytes, sha256: preFile.sha256, pointCount: preFile.points.count, ...(info.acquisition?.pre ?? {}) });

  const manifest = buildManifest({ info, inputs, outputs, processing: { ...processing, timings: T.summary() }, generator: GENERATOR });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const buildReport = {
    builtAt: new Date().toISOString(),
    machine: { node: process.version, platform: process.platform, arch: process.arch, cpus: (await import('node:os')).cpus().length },
    input: { postPoints: postFile.points.count, prePoints: preFile?.points.count ?? null, triangles: tin.triCount },
    timingsMs: T.summary(),
    peakRssMB: Math.round(process.memoryUsage().rss / 1048576),
    outputs: outputs.map((o) => ({ file: o.file, bytes: o.bytes })),
  };
  await writeFile(join(outDir, 'build-report.json'), JSON.stringify(buildReport, null, 2), 'utf8');

  log('\n---- 実測値 ----');
  for (const [k, v] of Object.entries(T.summary())) log(`  ${k.padEnd(12)} ${(v / 1000).toFixed(2)} s`);
  log(`  ${'合計'.padEnd(12)} ${(T.total() / 1000).toFixed(2)} s`);
  log(`  Node 最大 RSS  ${buildReport.peakRssMB} MB`);
  log(`\n完了: ${outDir}`);
}

// ---------------- 補助 ----------------

function renderIndexHtmlExternal(cfg, info) {
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c').replace(SEP_RE, (c) => '\\u' + c.charCodeAt(0).toString(16));
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(info.projectName ?? '点群ビューア')} — 点群ビューア</title>
<meta name="generator" content="${GENERATOR}">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%225%22%20fill%3D%22%231f5fa8%22%2F%3E%3Cg%20fill%3D%22%23fff%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%2221%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2214%22%20cy%3D%2218%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2220%22%20cy%3D%2214%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2226%22%20cy%3D%2210%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%229%22%20cy%3D%2213%22%20r%3D%221.4%22%20opacity%3D%22.65%22%2F%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2224%22%20r%3D%221.4%22%20opacity%3D%22.65%22%2F%3E%3Ccircle%20cx%3D%2223%22%20cy%3D%2220%22%20r%3D%221.4%22%20opacity%3D%22.65%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E">
<link rel="stylesheet" href="viewer.css">
</head>
<body>
<div id="app">
  <noscript><div class="boot-error"><h1>JavaScript が無効です</h1><p>このビューアは JavaScript を使用します。</p></div></noscript>
  <div id="boot" class="boot">読み込み中…</div>
</div>
<script type="application/json" id="tengun-config">${json}</script>
<script src="viewer.js"></script>
<script>
(function(){
  var cfg = JSON.parse(document.getElementById('tengun-config').textContent);
  if (location.protocol === 'file:') {
    document.getElementById('boot').innerHTML =
      '<div class="boot-error"><h1>この版は file:// では開けません</h1>'
      + '<p>これは Web サーバに置いて使う「フル版」です。ブラウザの制約（CORS）により、'
      + 'ダブルクリックで開くとデータファイルを読み込めません。</p>'
      + '<p>同じフォルダに入っている <b>light</b> 版（単一 HTML）を開いてください。'
      + 'または、このフォルダを庁内の Web サーバに配置してください。</p></div>';
    return;
  }
  window.Tengun.start(cfg, document.getElementById('app'));
})();
</script>
</body>
</html>
`;
}

/**
 * 旧形式（単一リスト）の判定結果を様式-31-2 から作る。
 * 既存の CSV 帳票と画面が旧形式を前提にしているため、移行期の互換用。
 */
function legacyJudgement(sheet) {
  const results = [];
  for (const p of sheet.parts) {
    for (const r of p.rows) {
      results.push({ ...r, label: `${p.name} ${r.label}`, ratioPercent: null, marginPercent: marginOf(r) });
    }
  }
  return {
    workType: sheet.workType, workTypeName: sheet.workTypeName, measure: sheet.measureName,
    pass: sheet.pass, results, source: null, unverified: true,
  };
}

function marginOf(r) {
  const { min, max } = r.tolerance ?? {};
  if (!Number.isFinite(r.value)) return null;
  const c = [];
  if (max !== undefined && max !== 0) c.push(((max - r.value) / Math.abs(max)) * 100);
  if (min !== undefined && min !== 0) c.push(((r.value - min) / Math.abs(min)) * 100);
  return c.length ? Math.min(...c) : null;
}

function pickInfo(info) {
  const { $comment, $axisOrderNote, ...rest } = info;
  return rest;
}

function plainStats(s) {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number.isFinite(v) ? v : null]));
}

function filterByClass(dev, cls, keep) {
  if (!cls) return dev;
  const set = new Set(keep);
  const out = new Float32Array(dev.length);
  for (let i = 0; i < dev.length; i++) out[i] = set.has(cls[i]) ? dev[i] : NaN;
  return out;
}

function checkOverlap(points, tin, log) {
  const b = tin.bounds;
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let i = 0; i < points.count; i += Math.max(1, (points.count / 5000) | 0)) {
    if (points.e[i] < minE) minE = points.e[i];
    if (points.e[i] > maxE) maxE = points.e[i];
    if (points.n[i] < minN) minN = points.n[i];
    if (points.n[i] > maxN) maxN = points.n[i];
  }
  const ov = Math.min(maxE, b.maxE) - Math.max(minE, b.minE) > 0 && Math.min(maxN, b.maxN) - Math.max(minN, b.minN) > 0;
  if (!ov) {
    log('⚠ 点群と設計面が平面上で重なっていません。座標系または軸の並び（axisOrder）が違う可能性があります。');
    log(`   点群 E[${minE.toFixed(1)}, ${maxE.toFixed(1)}] N[${minN.toFixed(1)}, ${maxN.toFixed(1)}]`);
    log(`   設計 E[${b.minE.toFixed(1)}, ${b.maxE.toFixed(1)}] N[${b.minN.toFixed(1)}, ${b.maxN.toFixed(1)}]`);
  }
}

function siteSummary(points, info) {
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < points.count; i++) {
    if (points.e[i] < minE) minE = points.e[i];
    if (points.e[i] > maxE) maxE = points.e[i];
    if (points.n[i] < minN) minN = points.n[i];
    if (points.n[i] > maxN) maxN = points.n[i];
    if (points.h[i] < minH) minH = points.h[i];
    if (points.h[i] > maxH) maxH = points.h[i];
  }
  let center = null;
  try {
    const ll = planeToLl((minE + maxE) / 2, (minN + maxN) / 2, info.epsg);
    center = { lat: ll.lat, lon: ll.lon, label: `${toDms(ll.lat, true)} ${toDms(ll.lon, false)}` };
  } catch { /* 平面直角座標系でない場合は表示しない */ }
  return { bounds: { minE, maxE, minN, maxN, minH, maxH }, center, epsg: info.epsg, crsLabel: info.crsLabel };
}

function buildSections(points, tin, { interval, toleranceM, judgeGroundOnly }) {
  // 設計 TIN の主軸に沿って中心線を引き、そこから一定間隔の横断測線を作る
  const b = tin.bounds;
  const along = (b.maxE - b.minE) >= (b.maxN - b.minN);
  const centerline = along
    ? [{ e: b.minE, n: (b.minN + b.maxN) / 2 }, { e: b.maxE, n: (b.minN + b.maxN) / 2 }]
    : [{ e: (b.minE + b.maxE) / 2, n: b.minN }, { e: (b.minE + b.maxE) / 2, n: b.maxN }];
  const width = Math.max(b.maxE - b.minE, b.maxN - b.minN);
  const lines = crossSectionLines(centerline, { interval, width });

  const summary = [], svgs = [];
  for (const line of lines.slice(0, 40)) {
    const sec = extractSection(points, tin, line, { halfWidth: 0.5 });
    if (sec.points.length < 20) continue;
    const dev = new Float32Array(sec.points.length);
    for (let i = 0; i < sec.points.length; i++) dev[i] = sec.points[i].deviation;
    const st = deviationStats(dev, { withinToleranceM: toleranceM });
    const pass = Number.isFinite(st.mean) && Math.abs(st.mean) <= toleranceM;
    summary.push({ label: line.label, station: line.station, line: { e1: line.e1, n1: line.n1, e2: line.e2, n2: line.n2 }, stats: st, pass });
    if (svgs.length < 12) {
      svgs.push({ file: `断面_${line.label.replace(/\./g, '')}.svg`, svg: sectionSvg(sec, { title: `横断図 ${line.label}` }) });
    }
  }
  return { summary, svgs };
}

function earthworkCsv(pre, post, tin) {
  // 起工測量と出来形の格子標高差から掘削・盛土の概算土量を出す（参考値）
  const cell = 0.5;
  const b = tin.bounds;
  const cols = Math.max(1, Math.ceil((b.maxE - b.minE) / cell));
  const rows = Math.max(1, Math.ceil((b.maxN - b.minN) / cell));
  const acc = (p) => {
    const z = new Float64Array(cols * rows), c = new Int32Array(cols * rows);
    for (let i = 0; i < p.count; i++) {
      if (p.classification && p.classification[i] !== 2 && p.classification[i] !== 11) continue;
      const cx = ((p.e[i] - b.minE) / cell) | 0, cy = ((p.n[i] - b.minN) / cell) | 0;
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      const k = cy * cols + cx; z[k] += p.h[i]; c[k]++;
    }
    for (let k = 0; k < z.length; k++) if (c[k]) z[k] /= c[k];
    return { z, c };
  };
  const A = acc(pre), B = acc(post);
  let cut = 0, fill = 0, cells = 0;
  for (let k = 0; k < A.z.length; k++) {
    if (!A.c[k] || !B.c[k]) continue;
    const d = B.z[k] - A.z[k];
    if (d < 0) cut += -d * cell * cell; else fill += d * cell * cell;
    cells++;
  }
  return toCsv([
    ['土量集計（参考値）'],
    ['※ 格子標高差による概算。数量計算書の代わりにはなりません。'],
    ['格子間隔(m)', cell],
    ['有効格子数', cells],
    ['有効面積(m2)', (cells * cell * cell).toFixed(1)],
    ['掘削土量(m3)', cut.toFixed(1)],
    ['盛土量(m3)', fill.toFixed(1)],
    ['差引(m3)', (fill - cut).toFixed(1)],
  ]);
}

function progress(log, prefix = '  ') {
  // 端末でないとき（CI・ログへのリダイレクト）は \r が効かず行が膨らむので間引く
  const tty = process.stdout.isTTY;
  let last = -1;
  return (done, total) => {
    const pct = Math.floor((done / total) * 100);
    const step = tty ? 1 : 25;
    if (pct === last || pct % step !== 0) return;
    last = pct;
    const line = `${prefix} ${String(pct).padStart(3)}%  ${done.toLocaleString()} / ${total.toLocaleString()}   `;
    process.stdout.write(tty ? `\r${line}` : `${line}\n`);
  };
}

class Timer {
  constructor() { this.t = {}; this.marks = {}; this.t0 = performance.now(); }
  mark(k) { this.marks[k] = performance.now(); }
  done(k) { this.t[k] = (this.t[k] ?? 0) + (performance.now() - this.marks[k]); }
  summary() { return Object.fromEntries(Object.entries(this.t).map(([k, v]) => [k, Math.round(v)])); }
  total() { return performance.now() - this.t0; }
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const fmtNum = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const fmtTol = (t) => `${t.min ?? '—'} 〜 ${t.max ?? '—'}`;

main().catch((err) => {
  console.error(`\nエラー: ${err.message}`);
  if (process.env.TENGUN_DEBUG) console.error(err.stack);
  process.exit(1);
});
