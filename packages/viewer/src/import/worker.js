/**
 * 取り込み処理のワーカ。
 *
 * 重い処理（LAS 解析・較差計算・octree 構築）は全部ここでやる。
 * 画面が固まると「壊れた」と思われるので、必ずワーカに逃がすこと。
 *
 * 【方針】判定・統計は常に全点で計算する。間引かない。
 *         間引きは描画のために octree が行うだけで、数字には一切触れない。
 */
import {
  parseLandXml, TinSurface, computeDeviations, deviationStats, histogram,
  loadSpec, buildOctree, serializeOctree, serializeTin, describeCrs,
  planeToLl, toDms, extractSection, crossSectionLines, histogramCsv, toCsv,
  MEASURES, computeElevationDeviations, computeHorizontalDeviations, classifyParts,
  horizontalArea, buildSheet, sheetCsv,
} from '@tengun/core';
import specValues from '../../../../docs/spec-values.json';
import { readPointBuffer } from './read-file.js';

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);
const progress = (phase, done, total) => post({ type: 'progress', phase, done, total });

self.onmessage = async (ev) => {
  const { type, payload } = ev.data;
  if (type !== 'import') return;
  try {
    const result = await run(payload);
    // ArrayBuffer は転送する（コピーすると数十 MB 級で無駄が出る）
    post({ type: 'result', payload: result }, result.transfers);
  } catch (err) {
    post({ type: 'error', message: err?.message ?? String(err), stack: err?.stack });
  }
};

async function run({ pointsBuffer, preBuffer, designText, infoText, options }) {
  const t0 = performance.now();
  const timings = {};
  const mark = (k, t) => { timings[k] = Math.round(performance.now() - t); };

  // ---- 工事情報（任意）----
  let info = {};
  if (infoText) {
    try { info = JSON.parse(infoText); }
    catch (e) { throw new Error(`工事情報 JSON を読めません: ${e.message}`); }
  }
  const warnings = [];
  if (!info.epsg) {
    warnings.push('工事情報に座標系(epsg)がないため、緯度経度は表示しません。較差の計算には影響しません。');
  } else {
    info.crsLabel = describeCrs(info.epsg);
  }
  if (!info.projectName) info.projectName = options?.fileName ?? '（工事名未設定）';
  const axisOrder = info.axisOrder ?? options?.axisOrder ?? 'EN';

  // ---- 設計 TIN ----
  let t = performance.now();
  progress('設計データを解析中', 0, 1);
  const designDoc = parseLandXml(designText, { pointOrder: info.design?.pointOrder ?? 'NEH' });
  const surf = designDoc.surfaces[0];
  const tin = new TinSurface({ e: surf.e, n: surf.n, h: surf.h, faces: surf.faces, name: surf.name });
  mark('design', t);
  if (!info.epsg && designDoc.coordinateSystem?.epsgCode) {
    info.epsg = Number(designDoc.coordinateSystem.epsgCode);
    info.crsLabel = describeCrs(info.epsg);
    warnings.push(`座標系を LandXML の epsgCode から取りました: ${info.crsLabel}`);
  }

  // ---- 点群 ----
  t = performance.now();
  progress('点群を読み込み中', 0, 1);
  const { points, header } = await readPointBuffer(pointsBuffer, {
    onProgress: (p) => progress(p.phase, p.done, p.total),
  });
  applyAxis(points, axisOrder);
  mark('readPoints', t);

  checkOverlap(points, tin, warnings);

  // ---- 較差（全点）----
  // CLI（ptv build）と同じ計算を通す。取り込みでも変換でも数字が変わってはいけない。
  t = performance.now();
  const spec = loadSpec(specValues);
  const workTypeId = info.workType ?? options?.workType ?? spec.workTypes[0].id;
  const wt = spec.workTypes.find((w) => w.id === workTypeId) ?? spec.workTypes[0];
  const toleranceM = wt.toleranceM ?? spec.defaults?.toleranceM ?? 0.05;
  const maxDistance = options?.maxDistanceM ?? spec.defaults?.maxDistanceM ?? 5;
  const measureId = options?.measure ?? wt.measure ?? spec.defaults?.measure ?? 'elevation';
  const measure = MEASURES[measureId] ?? MEASURES.elevation;

  const primary = measureId === 'elevation'
    ? computeElevationDeviations(points, tin, { onProgress: (d, n2) => progress(`${measure.name}を計算中`, d, n2) })
    : measureId === 'horizontal'
      ? computeHorizontalDeviations(points, tin, { onProgress: (d, n2) => progress(`${measure.name}を計算中`, d, n2) })
      : computeDeviations(points, tin, { maxDistance, onProgress: (d, n2) => progress(`${measure.name}を計算中`, d, n2) });
  points.deviation = primary.deviation;
  const inRange = primary.inRange, outOfRange = primary.outOfRange;

  if (measureId !== 'normal') {
    const alt = computeDeviations(points, tin, {
      maxDistance, onProgress: (d, n2) => progress('法線方向較差を計算中（表示用）', d, n2),
    });
    points.deviationAlt = alt.deviation;
  }
  mark('deviation', t);

  // ---- 部位分け（天端 / 法面）----
  t = performance.now();
  const slopeThresholdDeg = options?.slopeThresholdDeg ?? spec.defaults?.slopeThresholdDeg ?? 15;
  progress('部位を判定中（天端 / 法面）', 0, 1);
  const { part, counts: partCounts } = classifyParts(points, tin, { slopeThresholdDeg });
  const areaByPart = {};
  for (const pdef of wt.parts ?? []) {
    const steep = pdef.slope === 'steep';
    areaByPart[pdef.id] = horizontalArea(tin, (ti) => (tin.slopeDeg(ti) >= slopeThresholdDeg) === steep);
  }
  mark('parts', t);

  // ---- 判定（様式-31-2）----
  const groundOnly = options?.groundOnly !== false;
  const judgeDev = groundOnly ? filterByClass(primary.deviation, points.classification, [2, 11]) : primary.deviation;
  const sheet = buildSheet(judgeDev, part, wt, { areaByPart });
  const stats = deviationStats(judgeDev, { withinToleranceM: toleranceM });
  const hist = histogram(judgeDev, { bins: 61, range: [-toleranceM * 1.4, toleranceM * 1.4] });

  // ---- 描画用 octree（ここだけが間引く。数字には触れない）----
  t = performance.now();
  const datasets = [];
  const transfers = [];
  const inline = { datasets: {} };

  const tree = buildOctree(points, {
    onProgress: (done, total) => progress('表示用データを作成中', done, total),
  });
  const { bin, hierarchy } = serializeOctree(tree, points);
  datasets.push({ id: 'post', label: '出来形', hierarchy, pointCount: hierarchy.pointCount, imported: true });
  inline.datasets.post = bin.buffer;
  transfers.push(bin.buffer);
  const origin = hierarchy.origin;

  if (preBuffer) {
    progress('起工測量点群を読み込み中', 0, 1);
    const pre = (await readPointBuffer(preBuffer)).points;
    applyAxis(pre, axisOrder);
    const t2 = buildOctree(pre, { origin });
    const s2 = serializeOctree(t2, pre);
    datasets.push({ id: 'pre', label: '起工測量', hierarchy: s2.hierarchy, pointCount: s2.hierarchy.pointCount, imported: true });
    inline.datasets.pre = s2.bin.buffer;
    transfers.push(s2.bin.buffer);
  }
  mark('octree', t);

  const designPayload = serializeTin(tin, origin);
  inline.design = designPayload.bin.buffer;
  transfers.push(designPayload.bin.buffer);

  // ---- 横断測点 ----
  const sections = buildSections(points, tin, { interval: options?.sectionInterval ?? 20, toleranceM });

  // ---- 帳票（取り込みでも同じ CSV が出せる）----
  inline.reports = {
    '出来形合否判定総括表.csv': sheetCsv(sheet, { info, toCsv }),
    'histogram.csv': histogramCsv(judgeDev, { bins: 61, range: [-toleranceM * 1.4, toleranceM * 1.4] }),
  };

  const site = summarizeSite(points, info);

  return {
    config: {
      generator: 'tengun viewer（ブラウザ取り込み）',
      builtAt: new Date().toISOString(),
      mode: 'imported',
      info,
      sheet,
      measure: { id: measureId, ...measure },
      parts: { slopeThresholdDeg, counts: partCounts, areaByPart },
      stats: plain(stats),
      histogram: { bins: hist.bins, range: hist.range, counts: Array.from(hist.counts), under: hist.under, over: hist.over, nan: hist.nan },
      defaults: { colorRangeM: spec.defaults?.colorRangeM ?? toleranceM, toleranceM },
      sections: sections.map((s) => ({ label: s.label, station: s.station, line: s.line, stats: plain(s.stats), pass: s.pass })),
      origin,
      site,
      specSource: spec.source ?? null,
      datasets,
      design: { inline: true, vertexCount: designPayload.vertexCount, triangleCount: designPayload.triangleCount, origin: designPayload.origin },
      reports: Object.keys(inline.reports).map((f) => ({ label: f, inline: f })),
      importSummary: {
        pointCount: points.count,
        evaluated: inRange,
        outOfRange,
        triangleCount: tin.triCount,
        lasVersion: header.version,
        hasColor: header.hasColor,
        groundOnly,
        totalMs: Math.round(performance.now() - t0),
        timings,
      },
      warnings,
    },
    inline,
    transfers,
  };
}

function applyAxis(points, axisOrder) {
  if (axisOrder === 'NE') { const t = points.e; points.e = points.n; points.n = t; }
}

function filterByClass(dev, cls, keep) {
  if (!cls) return dev;
  const set = new Set(keep);
  const out = new Float32Array(dev.length);
  for (let i = 0; i < dev.length; i++) out[i] = set.has(cls[i]) ? dev[i] : NaN;
  return out;
}

function plain(s) {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number.isFinite(v) ? v : null]));
}

function checkOverlap(points, tin, warnings) {
  const b = tin.bounds;
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  const step = Math.max(1, (points.count / 5000) | 0);
  for (let i = 0; i < points.count; i += step) {
    if (points.e[i] < minE) minE = points.e[i];
    if (points.e[i] > maxE) maxE = points.e[i];
    if (points.n[i] < minN) minN = points.n[i];
    if (points.n[i] > maxN) maxN = points.n[i];
  }
  const overlap = Math.min(maxE, b.maxE) > Math.max(minE, b.minE) && Math.min(maxN, b.maxN) > Math.max(minN, b.minN);
  if (!overlap) {
    warnings.push(
      '点群と設計面が平面上で重なっていません。座標系か軸の並び（X が東か北か）が違う可能性が高いです。' +
      `点群 E[${minE.toFixed(0)}, ${maxE.toFixed(0)}] N[${minN.toFixed(0)}, ${maxN.toFixed(0)}] / ` +
      `設計 E[${b.minE.toFixed(0)}, ${b.maxE.toFixed(0)}] N[${b.minN.toFixed(0)}, ${b.maxN.toFixed(0)}]`
    );
  }
}

function summarizeSite(points, info) {
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
  if (info.epsg) {
    try {
      const ll = planeToLl((minE + maxE) / 2, (minN + maxN) / 2, info.epsg);
      center = { lat: ll.lat, lon: ll.lon, label: `${toDms(ll.lat, true)} ${toDms(ll.lon, false)}` };
    } catch { /* 平面直角座標系でなければ出さない */ }
  }
  return { bounds: { minE, maxE, minN, maxN, minH, maxH }, center, epsg: info.epsg ?? null, crsLabel: info.crsLabel ?? null };
}

function buildSections(points, tin, { interval, toleranceM }) {
  const b = tin.bounds;
  const along = (b.maxE - b.minE) >= (b.maxN - b.minN);
  const centerline = along
    ? [{ e: b.minE, n: (b.minN + b.maxN) / 2 }, { e: b.maxE, n: (b.minN + b.maxN) / 2 }]
    : [{ e: (b.minE + b.maxE) / 2, n: b.minN }, { e: (b.minE + b.maxE) / 2, n: b.maxN }];
  const width = Math.max(b.maxE - b.minE, b.maxN - b.minN);
  const out = [];
  for (const line of crossSectionLines(centerline, { interval, width }).slice(0, 40)) {
    const sec = extractSection(points, null, line, { halfWidth: 0.5 });
    if (sec.points.length < 20) continue;
    const dev = new Float32Array(sec.points.length);
    for (let i = 0; i < sec.points.length; i++) dev[i] = sec.points[i].deviation;
    const st = deviationStats(dev, { withinToleranceM: toleranceM });
    out.push({
      label: line.label, station: line.station,
      line: { e1: line.e1, n1: line.n1, e2: line.e2, n2: line.n2 },
      stats: st, pass: Number.isFinite(st.mean) && Math.abs(st.mean) <= toleranceM,
    });
  }
  return out;
}
