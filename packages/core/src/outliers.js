/**
 * 棄却点（異常値）の判定。
 *
 * 出典: 国土交通省「３次元計測技術を用いた出来形管理要領（案）令和８年３月版」
 *       別紙１ 面管理編 第５章、様式-31-2「出来形合否判定総括表」
 *
 * 要領の様式には「棄却点数」欄があり、規格値は「0.3％以下」。
 * 平均値・最大値・最小値は「棄却点を除く」値として算出すると明記されている。
 *
 * 【注意】棄却の判定条件そのものの明文規定は、この要領本文からは読み取れなかった。
 * 様式の記載例（図１-２６〜２９）を見ると、個々の計測値に対する規格値
 * （天端 ±150mm / 法面 ±190mm 等）を超えた点の数が棄却点数に一致するため、
 * 「個々の計測値に対する規格値を超えた点を棄却点とする」と解釈して実装している。
 * この解釈は要領本文で確認が取れていない。運用前に発注者と確認すること。
 */

export const OUTLIER_RULE_NOTE =
  '棄却点は「個々の計測値に対する規格値を超えた点」と解釈している（要領の様式記載例からの推定。本文での明文規定は未確認）。';

/**
 * @param {Float32Array} dev 較差 (m)。NaN は評価対象外。
 * @param {number} individualToleranceM 個々の計測値に対する規格値 (m)
 * @returns {{mask:Uint8Array, outlierCount:number, evaluatedCount:number, ratio:number}}
 *          mask[i] = 1 なら棄却点
 */
export function markOutliers(dev, individualToleranceM) {
  const mask = new Uint8Array(dev.length);
  let outlierCount = 0, evaluatedCount = 0;
  for (let i = 0; i < dev.length; i++) {
    const v = dev[i];
    if (Number.isNaN(v)) continue;
    evaluatedCount++;
    if (Math.abs(v) > individualToleranceM) { mask[i] = 1; outlierCount++; }
  }
  return {
    mask,
    outlierCount,
    evaluatedCount,
    ratio: evaluatedCount ? outlierCount / evaluatedCount : NaN,
  };
}

/** 棄却点を NaN に置き換えた配列を返す（統計計算に渡す用） */
export function excludeOutliers(dev, mask) {
  const out = new Float32Array(dev.length);
  for (let i = 0; i < dev.length; i++) out[i] = mask[i] ? NaN : dev[i];
  return out;
}

/**
 * ばらつき: 規格値の ±50% 以内 / ±80% 以内に入る点の割合。
 * 要領の様式-31-2 にこの 2 段階の欄がある。
 * @param toleranceM 当該部位の平均値に対する規格値 (m)
 */
export function spreadRatios(dev, toleranceM, mask = null) {
  let n = 0, within50 = 0, within80 = 0;
  for (let i = 0; i < dev.length; i++) {
    if (mask && mask[i]) continue;
    const v = dev[i];
    if (Number.isNaN(v)) continue;
    n++;
    const a = Math.abs(v);
    if (a <= toleranceM * 0.5) within50++;
    if (a <= toleranceM * 0.8) within80++;
  }
  return {
    count: n,
    within50Count: within50, within50Ratio: n ? within50 / n : NaN,
    within80Count: within80, within80Ratio: n ? within80 / n : NaN,
  };
}

/**
 * 計測密度（点/m²）。要領の様式では「1点/㎡以上」が規格値。
 * 評価面積は設計 TIN の水平投影面積を使う。
 */
export function pointDensity(evaluatedCount, areaM2) {
  return areaM2 > 0 ? evaluatedCount / areaM2 : NaN;
}

/** TIN の水平投影面積（評価面積の算出用） */
export function horizontalArea(tin, filter = null) {
  let a = 0;
  for (let ti = 0; ti < tin.triCount; ti++) {
    if (filter && !filter(ti)) continue;
    const ia = tin.faces[ti * 3], ib = tin.faces[ti * 3 + 1], ic = tin.faces[ti * 3 + 2];
    a += Math.abs(
      (tin.e[ib] - tin.e[ia]) * (tin.n[ic] - tin.n[ia]) -
      (tin.e[ic] - tin.e[ia]) * (tin.n[ib] - tin.n[ia])
    ) / 2;
  }
  return a;
}
