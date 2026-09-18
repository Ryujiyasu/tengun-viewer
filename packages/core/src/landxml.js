/**
 * LandXML 1.2 TIN サーフェスの読み込み。
 * 仕様が単純なので DOM ライブラリには依存しない（大きい TIN でも文字列走査で済ませる）。
 *
 * 【重要】<P> の座標順は LandXML 仕様上「northing easting elevation」（北 東 標高）。
 *         内部表現 (e=東, n=北, h=標高) に詰め替える。
 *         CAD によっては easting northing で吐くものがあるため、pointOrder で上書きできる。
 */

function attr(tagText, name) {
  const m = tagText.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : null;
}

/** 開始タグを位置 from 以降から探して、タグ全体と中身の範囲を返す */
function findElement(src, tagName, from = 0) {
  const openRe = new RegExp(`<${tagName}(\\s[^>]*)?(/)?>`, 'ig');
  openRe.lastIndex = from;
  const m = openRe.exec(src);
  if (!m) return null;
  const tagText = m[0];
  if (m[2] === '/') return { tagText, start: m.index, contentStart: -1, contentEnd: -1, end: openRe.lastIndex };
  const contentStart = openRe.lastIndex;
  const close = src.indexOf(`</${tagName}>`, contentStart);
  const contentEnd = close === -1 ? src.length : close;
  return { tagText, start: m.index, contentStart, contentEnd, end: contentEnd + tagName.length + 3 };
}

export function parseLandXml(text, { pointOrder = 'NEH' } = {}) {
  if (!/<LandXML/i.test(text)) throw new Error('LandXML ではありません（<LandXML> 要素が見つからない）');

  const root = findElement(text, 'LandXML');
  const version = attr(root.tagText, 'version') || '不明';

  const units = findElement(text, 'Metric');
  const linearUnit = units ? attr(units.tagText, 'linearUnit') : null;
  if (linearUnit && !/^meter$/i.test(linearUnit)) {
    throw new Error(`単位が meter ではありません: ${linearUnit}。メートル系に変換してから渡してください`);
  }
  if (!units && findElement(text, 'Imperial')) {
    throw new Error('ヤード・ポンド法の LandXML です。メートル系に変換してから渡してください');
  }

  const csEl = findElement(text, 'CoordinateSystem');
  const coordinateSystem = csEl
    ? {
        epsgCode: attr(csEl.tagText, 'epsgCode'),
        name: attr(csEl.tagText, 'name') || attr(csEl.tagText, 'desc'),
        horizontalDatum: attr(csEl.tagText, 'horizontalDatum'),
      }
    : null;

  const projectEl = findElement(text, 'Project');
  const projectName = projectEl ? attr(projectEl.tagText, 'name') : null;

  const surfaces = [];
  let cursor = 0;
  for (;;) {
    const sEl = findElement(text, 'Surface', cursor);
    if (!sEl) break;
    cursor = sEl.end;
    const name = attr(sEl.tagText, 'name') || `surface${surfaces.length + 1}`;
    const desc = attr(sEl.tagText, 'desc');
    const body = text.slice(sEl.contentStart, sEl.contentEnd);

    const defEl = findElement(body, 'Definition');
    if (!defEl) continue;
    const surfType = attr(defEl.tagText, 'surfType');
    if (surfType && !/^TIN$/i.test(surfType)) continue; // grid サーフェスは対象外

    const defBody = body.slice(defEl.contentStart, defEl.contentEnd);
    const pnts = parsePnts(defBody, pointOrder);
    const faces = parseFaces(defBody, pnts.idToIndex);
    if (faces.count === 0) continue;

    surfaces.push({ name, desc, pointCount: pnts.count, ...pnts, ...faces });
  }

  if (surfaces.length === 0) throw new Error('TIN サーフェスが 1 つも見つかりませんでした');
  return { version, coordinateSystem, projectName, surfaces };
}

function parsePnts(defBody, pointOrder) {
  const pEl = findElement(defBody, 'Pnts');
  if (!pEl) throw new Error('<Pnts> が見つかりません');
  const body = defBody.slice(pEl.contentStart, pEl.contentEnd);

  const re = /<P\b([^>]*)>([^<]*)<\/P>/g;
  const es = [], ns = [], hs = [];
  const idToIndex = new Map();
  let m, idx = 0;
  while ((m = re.exec(body))) {
    const id = attr(m[1] + ' ', 'id');
    const nums = m[2].trim().split(/\s+/);
    if (nums.length < 3) continue;
    const a = Number(nums[0]), b = Number(nums[1]), c = Number(nums[2]);
    // NEH: a=北 b=東 / ENH: a=東 b=北
    if (pointOrder === 'ENH') { es.push(a); ns.push(b); } else { ns.push(a); es.push(b); }
    hs.push(c);
    idToIndex.set(id ?? String(idx + 1), idx);
    idx++;
  }
  if (idx === 0) throw new Error('<Pnts> に点がありません');
  return {
    count: idx,
    e: Float64Array.from(es),
    n: Float64Array.from(ns),
    h: Float64Array.from(hs),
    idToIndex,
  };
}

function parseFaces(defBody, idToIndex) {
  const fEl = findElement(defBody, 'Faces');
  if (!fEl) return { count: 0, faces: new Int32Array(0) };
  const body = defBody.slice(fEl.contentStart, fEl.contentEnd);

  const re = /<F\b([^>]*)>([^<]*)<\/F>/g;
  const out = [];
  let m, skipped = 0;
  while ((m = re.exec(body))) {
    // i="1" は不可視面（穴・境界外）。TIN の実体ではないので除外する。
    if (/\bi\s*=\s*["']1["']/i.test(m[1])) { skipped++; continue; }
    const ids = m[2].trim().split(/\s+/);
    if (ids.length < 3) continue;
    const a = idToIndex.get(ids[0]), b = idToIndex.get(ids[1]), c = idToIndex.get(ids[2]);
    if (a === undefined || b === undefined || c === undefined) { skipped++; continue; }
    out.push(a, b, c);
  }
  return { count: out.length / 3, faces: Int32Array.from(out), skippedFaces: skipped };
}
