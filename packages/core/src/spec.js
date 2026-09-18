/**
 * 出来形管理基準の規格値判定。
 *
 * 規格値そのものはこのファイルに書かない。docs/ の JSON から読む。
 * 要領は改定されるので、コードの更新なしに値を差し替えられる状態を保つこと。
 */

/** 統計量 → 判定に使う値（表示単位 mm / %） */
const EXTRACTORS = {
  mean: (s) => s.mean * 1000,
  stddev: (s) => s.stddev * 1000,
  max: (s) => s.max * 1000,
  min: (s) => s.min * 1000,
  maxAbs: (s) => s.maxAbs * 1000,
  rms: (s) => s.rms * 1000,
  median: (s) => s.median * 1000,
  p95: (s) => s.p95 * 1000,
  withinRatio: (s) => s.withinRatio * 100,
  count: (s) => s.count,
};

export function loadSpec(json) {
  const spec = typeof json === 'string' ? JSON.parse(json) : json;
  if (!spec.workTypes?.length) throw new Error('規格値定義に workTypes がありません');
  for (const wt of spec.workTypes) {
    for (const c of wt.criteria ?? []) {
      if (!EXTRACTORS[c.stat]) {
        throw new Error(`規格値定義の stat が未対応です: ${c.stat}（工種 ${wt.id} / 基準 ${c.id}）`);
      }
    }
  }
  return spec;
}

export function findWorkType(spec, id) {
  const wt = spec.workTypes.find((w) => w.id === id);
  if (!wt) {
    throw new Error(
      `工種 "${id}" が規格値定義にありません。利用できるのは: ${spec.workTypes.map((w) => w.id).join(', ')}`
    );
  }
  return wt;
}

/**
 * 規格値判定を行う。
 * @returns {{workType:string, pass:boolean, results:Array, source:object, unverified:boolean}}
 */
export function judge(spec, workTypeId, stats) {
  const wt = findWorkType(spec, workTypeId);
  const results = (wt.criteria ?? []).map((c) => {
    const value = EXTRACTORS[c.stat](stats);
    const { min, max } = c.tolerance ?? {};
    let pass = true;
    if (min !== undefined && !(value >= min)) pass = false;
    if (max !== undefined && !(value <= max)) pass = false;
    if (Number.isNaN(value)) pass = false;

    // 規格値に対する割合（100% で規格値ぴったり）
    let ratio = null;
    const limit = pickLimit(value, min, max);
    if (limit !== null && limit !== 0) ratio = Math.abs(value / limit) * 100;

    // 余裕: 規格値まであとどれだけあるか（規格値に対する %）。
    // 上限規格と下限規格で「大きいほど良い/悪い」が逆転するため、
    // 割合だけを出すと下限規格（例: 規格値内の割合 80% 以上）で 124% のような
    // 誤解を招く表示になる。正 = 合格方向の余裕、負 = 超過、で符号を揃える。
    let margin = null;
    if (Number.isFinite(value)) {
      const cands = [];
      if (max !== undefined && max !== 0) cands.push(((max - value) / Math.abs(max)) * 100);
      if (min !== undefined && min !== 0) cands.push(((value - min) / Math.abs(min)) * 100);
      if (cands.length) margin = Math.min(...cands);
    }

    return {
      id: c.id,
      label: c.label,
      stat: c.stat,
      unit: c.unit ?? 'mm',
      value,
      tolerance: c.tolerance ?? {},
      pass,
      ratioPercent: ratio,
      marginPercent: margin,
      note: c.note ?? null,
      source: c.source ?? null,
    };
  });

  return {
    workType: wt.id,
    workTypeName: wt.name,
    measure: wt.measure ?? '法線方向較差',
    pass: results.every((r) => r.pass),
    results,
    source: spec.source ?? null,
    unverified: spec.source?.verified !== true,
  };
}

function pickLimit(value, min, max) {
  if (min !== undefined && max !== undefined) return value < 0 ? min : max;
  if (max !== undefined) return max;
  if (min !== undefined) return min;
  return null;
}
