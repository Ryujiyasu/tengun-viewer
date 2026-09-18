/**
 * 座標系ユーティリティ
 *
 * 【重要】軸の向きについて
 *   日本の公共座標（平面直角座標系）は  X = 北（northing） / Y = 東（easting）
 *   LAS ファイルのヘッダ・点レコードは   X = 東（easting）  / Y = 北（northing）
 *   LandXML の <P> 要素は既定で          "northing easting elevation" の順
 *
 * 取り違えると工区が 90 度回る。内部表現は一貫して
 *   e = easting（東）, n = northing（北）, h = 標高
 * とし、入出力の境界でのみ変換する。
 */

/** 平面直角座標系 系番号 → 原点（度）。測量法施行令第2条第2項に基づく。 */
export const JPZONE_ORIGINS = {
  1:  { lat: 33.0,       lon: 129.5      },
  2:  { lat: 33.0,       lon: 131.0      },
  3:  { lat: 36.0,       lon: 132.0 + 10 / 60 },
  4:  { lat: 33.0,       lon: 133.5      },
  5:  { lat: 36.0,       lon: 134.0 + 20 / 60 },
  6:  { lat: 36.0,       lon: 136.0      },
  7:  { lat: 36.0,       lon: 137.0 + 10 / 60 },
  8:  { lat: 36.0,       lon: 138.5      },
  9:  { lat: 36.0,       lon: 139.0 + 50 / 60 },
  10: { lat: 40.0,       lon: 140.0 + 50 / 60 },
  11: { lat: 44.0,       lon: 140.0 + 15 / 60 },
  12: { lat: 44.0,       lon: 142.0 + 15 / 60 },
  13: { lat: 44.0,       lon: 144.0 + 15 / 60 },
  14: { lat: 26.0,       lon: 142.0      },
  15: { lat: 26.0,       lon: 127.5      },
  16: { lat: 26.0,       lon: 124.0      },
  17: { lat: 26.0,       lon: 131.0      },
  18: { lat: 20.0,       lon: 136.0      },
  19: { lat: 26.0,       lon: 154.0      },
};

const ZONE_KANJI = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX'];

/** EPSG → { zone, datum }。JGD2011 = 6669..6687、JGD2000 = 2443..2461。 */
export function parseEpsg(epsg) {
  const code = typeof epsg === 'string' ? Number(String(epsg).replace(/^EPSG:/i, '')) : epsg;
  if (code >= 6669 && code <= 6687) return { code, zone: code - 6668, datum: 'JGD2011' };
  if (code >= 2443 && code <= 2461) return { code, zone: code - 2442, datum: 'JGD2000' };
  return { code, zone: null, datum: null };
}

export function epsgForZone(zone, datum = 'JGD2011') {
  if (!(zone >= 1 && zone <= 19)) throw new Error(`系番号が範囲外です: ${zone}`);
  return datum === 'JGD2000' ? 2442 + zone : 6668 + zone;
}

export function describeCrs(epsg) {
  const { code, zone, datum } = parseEpsg(epsg);
  if (!zone) return `EPSG:${code}`;
  return `EPSG:${code}（${datum} / 平面直角座標系 第${ZONE_KANJI[zone]}系）`;
}

// GRS80
const A = 6378137.0;
const RF = 298.257222101;
const F = 1 / RF;
const M0 = 0.9999; // 平面直角座標系の縮尺係数

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// 子午線弧長の級数係数（GRS80）— Kawase(2011) 国土地理院時報 の形式
//   S(φ) = a/(1+n) * [ A0·φ + Σ_{j=1..5} Aj·sin(2jφ) ]
const _MC = (() => {
  const n = F / (2 - F);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n;
  return {
    scale: A / (1 + n),
    A: [
      1 + n2 / 4 + n4 / 64,
      -1.5 * (n - n3 / 8 - n5 / 64),
      (15 / 16) * (n2 - n4 / 4),
      -(35 / 48) * (n3 - (5 / 16) * n5),
      (315 / 512) * n4,
      -(693 / 1280) * n5,
    ],
  };
})();

function meridianArc(phi) {
  const { scale, A: c } = _MC;
  let s = c[0] * phi;
  for (let j = 1; j <= 5; j++) s += c[j] * Math.sin(2 * j * phi);
  return scale * s;
}

/**
 * 緯度経度（度）→ 平面直角座標（m）。
 * 戻り値は測量座標の { x: 北, y: 東 } と、内部表現の { e: 東, n: 北 } の両方を持つ。
 */
export function llToPlane(latDeg, lonDeg, epsg) {
  const { zone } = parseEpsg(epsg);
  const org = JPZONE_ORIGINS[zone];
  if (!org) throw new Error(`平面直角座標系として解釈できません: ${epsg}`);

  const phi = latDeg * D2R;
  const lam = lonDeg * D2R;
  const lam0 = org.lon * D2R;
  const phi0 = org.lat * D2R;

  const e2 = F * (2 - F);
  const ep2 = e2 / (1 - e2);
  const N = A / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi);
  const eta2 = ep2 * Math.cos(phi) ** 2;
  const dl = lam - lam0;
  const c = Math.cos(phi);
  const l = dl * c;
  const l2 = l * l, l3 = l2 * l, l4 = l3 * l, l5 = l4 * l, l6 = l5 * l, l7 = l6 * l, l8 = l7 * l;
  const t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;

  const S = meridianArc(phi) - meridianArc(phi0);

  const north =
    M0 *
    (S +
      (N * t / 2) * l2 +
      (N * t / 24) * (5 - t2 + 9 * eta2 + 4 * eta2 * eta2) * l4 +
      (N * t / 720) * (61 - 58 * t2 + t4 + 270 * eta2 - 330 * t2 * eta2) * l6 +
      (N * t / 40320) * (1385 - 3111 * t2 + 543 * t4 - t6) * l8);

  const east =
    M0 *
    (N * l +
      (N / 6) * (1 - t2 + eta2) * l3 +
      (N / 120) * (5 - 18 * t2 + t4 + 14 * eta2 - 58 * t2 * eta2) * l5 +
      (N / 5040) * (61 - 479 * t2 + 179 * t4 - t6) * l7);

  return { x: north, y: east, n: north, e: east };
}

/** 平面直角座標（東 e / 北 n, m）→ 緯度経度（度）。 */
export function planeToLl(e, n, epsg) {
  const { zone } = parseEpsg(epsg);
  const org = JPZONE_ORIGINS[zone];
  if (!org) throw new Error(`平面直角座標系として解釈できません: ${epsg}`);

  const phi0 = org.lat * D2R;
  const lam0 = org.lon * D2R;
  const e2 = F * (2 - F);
  const ep2 = e2 / (1 - e2);

  // 底点緯度をニュートン法で求める
  const target = meridianArc(phi0) + n / M0;
  let phi1 = phi0 + n / (M0 * A);
  for (let i = 0; i < 12; i++) {
    const d = meridianArc(phi1) - target;
    const M = (A * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi1) ** 2, 1.5);
    const step = d / M;
    phi1 -= step;
    if (Math.abs(step) < 1e-13) break;
  }

  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const N1 = A / Math.sqrt(1 - e2 * s * s);
  const eta2 = ep2 * c * c;
  const t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;
  const y = e / M0;
  const d1 = y / N1;
  const d2 = d1 * d1, d3 = d2 * d1, d4 = d3 * d1, d5 = d4 * d1, d6 = d5 * d1, d7 = d6 * d1, d8 = d7 * d1;

  const lat =
    phi1 -
    (t / 2) * (1 + eta2) * d2 +
    (t / 24) * (5 + 3 * t2 + 6 * eta2 - 6 * t2 * eta2 - 3 * eta2 * eta2) * d4 -
    (t / 720) * (61 + 90 * t2 + 45 * t4) * d6 +
    (t / 40320) * (1385 + 3633 * t2 + 4095 * t4 + 1575 * t6) * d8;

  const lon =
    lam0 +
    (d1 -
      (1 / 6) * (1 + 2 * t2 + eta2) * d3 +
      (1 / 120) * (5 + 28 * t2 + 24 * t4 + 6 * eta2 + 8 * t2 * eta2) * d5 -
      (1 / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6) * d7) / c;

  return { lat: lat * R2D, lon: lon * R2D };
}

/** 度 → 度分秒の表示文字列 */
export function toDms(deg, isLat) {
  const sign = deg < 0 ? -1 : 1;
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d) * 60 - m) * 60;
  const hemi = isLat ? (sign > 0 ? 'N' : 'S') : (sign > 0 ? 'E' : 'W');
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(3).padStart(6, '0')}"${hemi}`;
}
