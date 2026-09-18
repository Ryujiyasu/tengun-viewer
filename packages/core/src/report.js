/**
 * 帳票データの生成（CSV / 断面 SVG）。
 * 見た目は既存の出来形管理帳票に寄せる。見慣れない様式は受け取ってもらえない。
 */
import { deviationStats, histogram } from './stats.js';

const CRLF = '\r\n';

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  // Excel が UTF-8 と判定できるよう BOM を付ける。付けないと日本語が化ける。
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join(CRLF) + CRLF;
}

/** 判定結果 CSV（出来形管理表の体裁） */
export function judgementCsv({ info, judgement, stats, sections = [] }) {
  const rows = [];
  rows.push(['出来形管理表（点群による面管理）']);
  rows.push([]);
  rows.push(['工事名', info.projectName ?? '']);
  rows.push(['工事番号', info.projectNumber ?? '']);
  rows.push(['発注者', info.owner ?? '']);
  rows.push(['受注者', info.contractor ?? '']);
  rows.push(['工期', `${info.startDate ?? ''} 〜 ${info.endDate ?? ''}`]);
  rows.push(['工種', judgement.workTypeName ?? judgement.workType]);
  rows.push(['計測項目', judgement.measure]);
  rows.push(['座標系', info.crsLabel ?? info.epsg ?? '']);
  rows.push(['出力日時', new Date().toISOString()]);
  rows.push([]);

  rows.push(['判定結果']);
  rows.push(['項目', '測定値', '単位', '規格値(下限)', '規格値(上限)', '規格値に対する割合(%)', '余裕(%)', '判定', '備考']);
  for (const r of judgement.results) {
    rows.push([
      r.label,
      fmt(r.value, 1),
      r.unit,
      r.tolerance.min ?? '',
      r.tolerance.max ?? '',
      r.ratioPercent === null ? '' : fmt(r.ratioPercent, 1),
      r.marginPercent === null || r.marginPercent === undefined ? '' : fmt(r.marginPercent, 1),
      r.pass ? '合格' : '不合格',
      r.note ?? '',
    ]);
  }
  rows.push(['総合判定', '', '', '', '', '', '', judgement.pass ? '合格' : '不合格', '']);
  rows.push(['※ 余裕は規格値までの残り。正＝合格方向の余裕、負＝規格値超過。']);
  rows.push([]);

  rows.push(['較差の統計（法線方向・単位 mm）']);
  rows.push(['評価点数', stats.count]);
  rows.push(['平均値', fmt(stats.mean * 1000, 2)]);
  rows.push(['標準偏差', fmt(stats.stddev * 1000, 2)]);
  rows.push(['最大値（設計面より上が正）', fmt(stats.max * 1000, 2)]);
  rows.push(['最小値', fmt(stats.min * 1000, 2)]);
  rows.push(['最大絶対値', fmt(stats.maxAbs * 1000, 2)]);
  rows.push(['中央値', fmt(stats.median * 1000, 2)]);
  rows.push(['RMS', fmt(stats.rms * 1000, 2)]);

  if (sections.length) {
    rows.push([]);
    rows.push(['横断測点ごとの較差（単位 mm）']);
    rows.push(['測点', '評価点数', '平均値', '標準偏差', '最大値', '最小値', '判定']);
    for (const s of sections) {
      rows.push([
        s.label, s.stats.count,
        fmt(s.stats.mean * 1000, 2), fmt(s.stats.stddev * 1000, 2),
        fmt(s.stats.max * 1000, 2), fmt(s.stats.min * 1000, 2),
        s.pass ? '合格' : '不合格',
      ]);
    }
  }

  if (judgement.unverified) {
    rows.push([]);
    rows.push(['※ この判定に用いた規格値定義は出典未確認です。最新の出来形管理要領の値に差し替えてから検査に使用してください。']);
    if (judgement.source?.title) rows.push(['参照した定義', judgement.source.title, judgement.source.revision ?? '']);
  }
  return toCsv(rows);
}

function fmt(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : '';
}

/** 較差ヒストグラムの CSV */
export function histogramCsv(dev, opts) {
  const hg = histogram(dev, opts);
  const rows = [['較差ヒストグラム'], ['下限(mm)', '上限(mm)', '度数', '比率(%)']];
  const total = hg.counts.reduce((a, b) => a + b, 0) + hg.under + hg.over;
  rows.push(['(下限未満)', fmt(hg.range[0] * 1000, 1), hg.under, fmt((hg.under / total) * 100, 2)]);
  for (let i = 0; i < hg.bins; i++) {
    const lo = (hg.range[0] + i * hg.binWidth) * 1000;
    rows.push([fmt(lo, 1), fmt(lo + hg.binWidth * 1000, 1), hg.counts[i], fmt((hg.counts[i] / total) * 100, 2)]);
  }
  rows.push([fmt(hg.range[1] * 1000, 1), '(上限超過)', hg.over, fmt((hg.over / total) * 100, 2)]);
  rows.push(['設計面範囲外(除外)', '', hg.nan, '']);
  return toCsv(rows);
}

/**
 * 測線に沿った断面を抽出する。
 * @param points SoA  @param tin 設計 TIN（null 可）
 * @param line {e1,n1,e2,n2}  @param halfWidth 測線からの抽出幅(m)
 */
export function extractSection(points, tin, line, { halfWidth = 0.5, designStep = 0.25 } = {}) {
  const dx = line.e2 - line.e1, dy = line.n2 - line.n1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { length: 0, points: [], design: [] };
  const ux = dx / len, uy = dy / len;

  const out = [];
  for (let i = 0; i < points.count; i++) {
    const re = points.e[i] - line.e1, rn = points.n[i] - line.n1;
    const t = re * ux + rn * uy;
    if (t < 0 || t > len) continue;
    const off = -re * uy + rn * ux; // 左が正
    if (Math.abs(off) > halfWidth) continue;
    out.push({
      station: t,
      offset: off,
      h: points.h[i],
      deviation: points.deviation ? points.deviation[i] : NaN,
    });
  }
  out.sort((a, b) => a.station - b.station);

  const design = [];
  if (tin) {
    for (let t = 0; t <= len + 1e-9; t += designStep) {
      const e = line.e1 + ux * t, n = line.n1 + uy * t;
      const h = tin.elevationAt(e, n);
      design.push({ station: t, h: Number.isNaN(h) ? null : h });
    }
  }
  return { length: len, points: out, design, line };
}

/**
 * 断面図 SVG。そのまま帳票に貼れるよう、単体で完結した SVG を返す。
 */
export function sectionSvg(section, {
  width = 900, height = 300, margin = { top: 28, right: 20, bottom: 40, left: 76 },
  title = '縦断図', vExaggeration = 1, colorScale = null, toleranceM = 0.05,
} = {}) {
  const pw = width - margin.left - margin.right;
  const ph = height - margin.top - margin.bottom;

  const hs = [];
  for (const p of section.points) hs.push(p.h);
  for (const d of section.design) if (d.h !== null) hs.push(d.h);
  if (!hs.length) return emptySvg(width, height, 'この測線上に点がありません');

  let hMin = Math.min(...hs), hMax = Math.max(...hs);
  const pad = Math.max((hMax - hMin) * 0.1, 0.2);
  hMin -= pad; hMax += pad;

  const sx = (st) => margin.left + (st / section.length) * pw;
  const sy = (h) => margin.top + ph - ((h - hMin) / (hMax - hMin)) * ph;

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);

  // 罫線（標高）
  const step = niceStep((hMax - hMin) / 6);
  for (let h = Math.ceil(hMin / step) * step; h <= hMax; h += step) {
    const y = sy(h);
    parts.push(`<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#e3e6ea" stroke-width="1"/>`);
    parts.push(`<text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#5a6470" text-anchor="end">${h.toFixed(2)}</text>`);
  }
  // 罫線（測点）
  const stepS = niceStep(section.length / 8);
  for (let s = 0; s <= section.length + 1e-9; s += stepS) {
    const x = sx(s);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${margin.top}" x2="${x.toFixed(1)}" y2="${margin.top + ph}" stroke="#eef1f4" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${height - margin.bottom + 16}" font-size="11" fill="#5a6470" text-anchor="middle">${s.toFixed(0)}</text>`);
  }

  // 実測点
  for (const p of section.points) {
    const c = colorScale ? colorScale(p.deviation) : '#2b4a6f';
    parts.push(`<circle cx="${sx(p.station).toFixed(1)}" cy="${sy(p.h).toFixed(1)}" r="1.5" fill="${c}"/>`);
  }

  // 設計線は実測点より後に描く。先に描くと点群に埋もれて見えない。
  const dpts = section.design.filter((d) => d.h !== null);
  if (dpts.length > 1) {
    const d = dpts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.station).toFixed(1)},${sy(p.h).toFixed(1)}`).join('');
    parts.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-width="3.2" opacity="0.85"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="#c0392b" stroke-width="1.8" stroke-dasharray="7 4"/>`);
    parts.push(`<g transform="translate(${margin.left + 10},${margin.top + 12})">`
      + `<line x1="0" y1="0" x2="22" y2="0" stroke="#c0392b" stroke-width="1.8" stroke-dasharray="7 4"/>`
      + `<text x="27" y="4" font-size="11" fill="#5a6470">設計面</text></g>`);
  }

  parts.push(`<rect x="${margin.left}" y="${margin.top}" width="${pw}" height="${ph}" fill="none" stroke="#98a2ad" stroke-width="1"/>`);
  parts.push(`<text x="${margin.left}" y="18" font-size="13" font-weight="bold" fill="#1d2733">${escapeXml(title)}</text>`);
  parts.push(`<text x="${width - margin.right}" y="18" font-size="11" fill="#5a6470" text-anchor="end">測点 L=${section.length.toFixed(1)}m / 点数 ${section.points.length}</text>`);
  parts.push(`<text x="17" y="${margin.top + ph / 2}" font-size="11" fill="#5a6470" transform="rotate(-90 17 ${margin.top + ph / 2})" text-anchor="middle">標高 (m)</text>`);
  parts.push(`<text x="${margin.left + pw / 2}" y="${height - 6}" font-size="11" fill="#5a6470" text-anchor="middle">測点距離 (m)</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">${parts.join('')}</svg>`;
}

function emptySvg(w, h, msg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="sans-serif"><rect width="${w}" height="${h}" fill="#fff"/><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="13" fill="#7a838d">${escapeXml(msg)}</text></svg>`;
}

function niceStep(raw) {
  const exp = Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const base = Math.pow(10, exp);
  const m = raw / base;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * base;
}

export function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** 一定間隔の横断測線を生成する（既定 20m） */
export function crossSectionLines(centerline, { interval = 20, width = 30 } = {}) {
  const lines = [];
  let acc = 0;
  for (let i = 0; i < centerline.length - 1; i++) {
    const a = centerline[i], b = centerline[i + 1];
    const dx = b.e - a.e, dy = b.n - a.n;
    const seg = Math.hypot(dx, dy);
    if (seg < 1e-9) continue;
    const ux = dx / seg, uy = dy / seg;
    for (let t = acc === 0 ? 0 : interval - (acc % interval); t <= seg; t += interval) {
      const e = a.e + ux * t, n = a.n + uy * t;
      lines.push({
        station: acc + t,
        label: `No.${Math.floor((acc + t) / interval)}`,
        e1: e - (-uy) * (width / 2), n1: n - ux * (width / 2),
        e2: e + (-uy) * (width / 2), n2: n + ux * (width / 2),
      });
    }
    acc += seg;
  }
  return lines;
}
