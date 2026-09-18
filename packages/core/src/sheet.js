/**
 * 出来形合否判定総括表（様式-31-2）の組み立て。
 *
 * 出典: 国土交通省「３次元計測技術を用いた出来形管理要領（案）令和８年３月版」
 *       別紙１ 面管理編 図１-２６〜図１-２９（様式-31-2 の記載例）
 *
 * 要領の様式は部位（天端・法面など）ごとに
 *   平均値 / 最大値(差) / 最小値(差) / データ数 / 評価面積 / 棄却点数 / ばらつき(±50%,±80%)
 * を並べ、部位ごとに異なる規格値で判定する。
 * 平均値・最大値・最小値は棄却点を除いて算出する。
 */
import { deviationStats } from './stats.js';
import { markOutliers, excludeOutliers, spreadRatios, pointDensity, OUTLIER_RULE_NOTE } from './outliers.js';
import { MEASURES } from './measures.js';

/**
 * @param {Float32Array} dev  較差 (m)。評価対象外は NaN。
 * @param {Uint8Array} part   1=天端(平場) / 2=法面 / 0=対象外（classifyParts の出力）
 * @param {object} workType   規格値定義の 1 工種
 * @param {{areaByPart:{[partId:string]:number}}} ctx
 */
export function buildSheet(dev, part, workType, ctx = {}) {
  const parts = [];
  for (const pdef of workType.parts ?? []) {
    const code = pdef.slope === 'steep' ? 2 : 1;
    // 当該部位の点だけを抜き出す
    const sub = new Float32Array(dev.length);
    for (let i = 0; i < dev.length; i++) sub[i] = part && part[i] !== code ? NaN : dev[i];

    const individual = pdef.individualToleranceM ?? null;
    const outl = individual !== null ? markOutliers(sub, individual)
      : { mask: new Uint8Array(dev.length), outlierCount: 0, evaluatedCount: countValid(sub), ratio: 0 };
    const clean = excludeOutliers(sub, outl.mask);
    const stats = deviationStats(clean, { withinToleranceM: pdef.toleranceM ?? 0.05 });
    const area = ctx.areaByPart?.[pdef.id] ?? NaN;
    const density = pointDensity(outl.evaluatedCount, area);
    const spread = spreadRatios(sub, pdef.toleranceM ?? 0.05, outl.mask);

    const values = {
      mean: stats.mean * 1000,
      max: stats.max * 1000,
      min: stats.min * 1000,
      count: outl.evaluatedCount,
      density,
      outlierCount: outl.outlierCount,
      outlierRatio: outl.ratio * 100,
      within50Ratio: spread.within50Ratio * 100,
      within80Ratio: spread.within80Ratio * 100,
      area,
    };

    const rows = (pdef.criteria ?? []).map((c) => {
      const value = values[c.stat];
      const { min, max } = c.tolerance ?? {};
      let pass = Number.isFinite(value);
      if (pass && min !== undefined && !(value >= min)) pass = false;
      if (pass && max !== undefined && !(value <= max)) pass = false;
      return {
        id: c.id, label: c.label, stat: c.stat, unit: c.unit ?? 'mm',
        value, tolerance: c.tolerance ?? {}, pass, note: c.note ?? null,
      };
    });

    parts.push({
      id: pdef.id,
      name: pdef.name,
      toleranceM: pdef.toleranceM ?? null,
      individualToleranceM: individual,
      rows,
      spread: {
        within50Ratio: spread.within50Ratio * 100, within50Count: spread.within50Count,
        within80Ratio: spread.within80Ratio * 100, within80Count: spread.within80Count,
      },
      stats,
      evaluatedCount: outl.evaluatedCount,
      outlierCount: outl.outlierCount,
      areaM2: area,
      pass: rows.every((r) => r.pass),
    });
  }

  const evaluated = parts.reduce((s, p) => s + p.evaluatedCount, 0);
  return {
    form: '様式-31-2 出来形合否判定総括表',
    workType: workType.id,
    workTypeName: workType.name,
    measure: workType.measure ?? 'elevation',
    measureName: MEASURES[workType.measure ?? 'elevation']?.name ?? '標高較差',
    measureIsOfficial: MEASURES[workType.measure ?? 'elevation']?.official ?? false,
    parts,
    evaluatedCount: evaluated,
    pass: parts.length > 0 && parts.every((p) => p.pass),
    verdict: parts.length === 0 ? '判定不能'
      : parts.every((p) => p.pass) ? '合格' : '異常値有',
    notes: [OUTLIER_RULE_NOTE],
  };
}

function countValid(a) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) n++;
  return n;
}

/** 様式-31-2 を CSV にする */
export function sheetCsv(sheet, { info = {}, toCsv }) {
  const rows = [];
  rows.push(['出来形合否判定総括表（様式-31-2 準拠）']);
  rows.push([]);
  rows.push(['工事名', info.projectName ?? '']);
  rows.push(['工事番号', info.projectNumber ?? '']);
  rows.push(['発注者', info.owner ?? '']);
  rows.push(['受注者', info.contractor ?? '']);
  rows.push(['工種', sheet.workTypeName]);
  rows.push(['測定項目', sheet.measureName]);
  rows.push(['合否判定結果', sheet.verdict]);
  rows.push(['座標系', info.crsLabel ?? '']);
  rows.push(['出力日時', new Date().toISOString()]);
  rows.push([]);

  for (const p of sheet.parts) {
    rows.push([p.name]);
    rows.push(['測定項目', '算出結果', '単位', '規格値(下限)', '規格値(上限)', '判定']);
    for (const r of p.rows) {
      rows.push([
        r.label,
        Number.isFinite(r.value) ? r.value.toFixed(r.unit === '点' ? 0 : 1) : '',
        r.unit,
        r.tolerance.min ?? '',
        r.tolerance.max ?? '',
        r.pass ? '合格' : '規格値外',
      ]);
    }
    rows.push(['評価面積', Number.isFinite(p.areaM2) ? p.areaM2.toFixed(1) : '', 'm2']);
    rows.push([`規格値±50%以内の割合`, p.spread.within50Ratio.toFixed(1), '%', '', '', '']);
    rows.push([`規格値±50%以内のデータ数`, p.spread.within50Count, '点']);
    rows.push([`規格値±80%以内の割合`, p.spread.within80Ratio.toFixed(1), '%', '', '', '']);
    rows.push([`規格値±80%以内のデータ数`, p.spread.within80Count, '点']);
    rows.push(['部位判定', '', '', '', '', p.pass ? '合格' : '規格値外']);
    rows.push([]);
  }

  rows.push(['総合判定', '', '', '', '', sheet.verdict]);
  rows.push([]);
  rows.push(['【注記】']);
  for (const n of sheet.notes) rows.push([n]);
  if (!sheet.measureIsOfficial) {
    rows.push([`測定項目「${sheet.measureName}」は要領に定めのない方式です。検査には標高較差または水平較差を使用してください。`]);
  }
  return toCsv(rows);
}
