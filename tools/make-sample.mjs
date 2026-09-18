#!/usr/bin/env node
/**
 * サンプル現場の生成。
 *
 * 実データが来る前に、パイプライン全体を動かして見せるための合成データ。
 * 鹿児島市内・平面直角座標系 第II系(EPSG:6670) に置いた、小段付き切土のり面を作る。
 *
 *   生成物:
 *     起工測量.las   施工前の地山（設計面より高い）
 *     出来形.las     施工後（設計面 + 誤差 + 局所的な出来形不良）
 *     設計.xml       LandXML 1.2 TIN
 *     工事情報.json
 *
 * 合成データだと分かるようにファイル名・工事名に「サンプル」を入れている。
 * 実データと取り違えて検査に出さないこと。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeLas } from '../packages/core/src/las.js';
import { escapeXml } from '../packages/core/src/report.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, [])
);

const OUT = args.out ?? 'sample';
const N_POST = Number(args.points ?? 2_000_000);
const N_PRE = Math.round(N_POST * 0.6);
const SEED = Number(args.seed ?? 20260918);

mkdirSync(OUT, { recursive: true });

// ---- 乱数（再現性のため固定シード） ----
let _s = SEED >>> 0;
function rnd() {
  _s ^= _s << 13; _s >>>= 0;
  _s ^= _s >> 17;
  _s ^= _s << 5; _s >>>= 0;
  return _s / 4294967296;
}
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- 現場の形 ----
const E0 = -42000.0;          // 東（第II系）
const N0 = -155500.0;         // 北
const H0 = 118.0;             // 法尻の標高
const BEARING = 24 * Math.PI / 180; // 測線方位（軸に平行でない現実的な配置）
const LENGTH = 120;           // 延長 m
const GRADE = -0.01;          // 縦断勾配 1% 下り

// 横断形状: [法尻からのオフセット(m), 法尻からの高さ(m)]
// 1:1.2 勾配の切土のり面 + 幅1.5m の小段 + 天端
const PROFILE = [
  [-6.0, 0.0],   // 法尻側の平場
  [0.0, 0.0],    // 法尻
  [9.6, 8.0],    // 1割2分で 8m 上がる
  [11.1, 8.05],  // 小段（水勾配で僅かに上がり）
  [20.7, 16.05], // 2段目
  [25.7, 16.05], // 天端
];
const OFF_MIN = PROFILE[0][0], OFF_MAX = PROFILE[PROFILE.length - 1][0];

function profileH(off) {
  if (off <= PROFILE[0][0]) return PROFILE[0][1];
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [o1, h1] = PROFILE[i], [o2, h2] = PROFILE[i + 1];
    if (off <= o2) return h1 + ((off - o1) / (o2 - o1)) * (h2 - h1);
  }
  return PROFILE[PROFILE.length - 1][1];
}

/** 設計面の標高 */
function designH(s, off) {
  return H0 + GRADE * s + profileH(off);
}

/** (測点 s, オフセット off) → 平面直角座標 (東, 北) */
function toWorld(s, off) {
  const cs = Math.cos(BEARING), sn = Math.sin(BEARING);
  return { e: E0 + s * cs - off * sn, n: N0 + s * sn + off * cs };
}

/** 横断方向の 3D 弧長テーブル（のり面上で点密度を均一にするため） */
const ARC = (() => {
  const steps = 2000;
  const off = [], len = [];
  let acc = 0;
  let prevOff = OFF_MIN, prevH = profileH(OFF_MIN);
  off.push(OFF_MIN); len.push(0);
  for (let i = 1; i <= steps; i++) {
    const o = OFF_MIN + ((OFF_MAX - OFF_MIN) * i) / steps;
    const h = profileH(o);
    acc += Math.hypot(o - prevOff, h - prevH);
    off.push(o); len.push(acc);
    prevOff = o; prevH = h;
  }
  return { off, len, total: acc };
})();

function offsetAtArc(t) {
  // 二分探索
  let lo = 0, hi = ARC.len.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ARC.len[mid] <= t) lo = mid; else hi = mid;
  }
  const f = (t - ARC.len[lo]) / Math.max(1e-9, ARC.len[hi] - ARC.len[lo]);
  return ARC.off[lo] + f * (ARC.off[hi] - ARC.off[lo]);
}

/**
 * 出来形の施工誤差（法線方向, m）。
 * ・全体に僅かな系統誤差
 * ・盛り気味の領域と、削りすぎの領域を 1 箇所ずつ入れて、カラーマップと判定が動くのを見せる
 */
function constructionError(s, off) {
  let d = 0.004; // 系統誤差 +4mm
  d += 0.045 * Math.exp(-(((s - 35) / 9) ** 2) - (((off - 14) / 4.5) ** 2));   // 盛り気味
  d -= 0.062 * Math.exp(-(((s - 78) / 7) ** 2) - (((off - 5.5) / 3.2) ** 2));  // 削りすぎ（局所不合格）
  d += 0.012 * Math.sin(s / 11) * Math.cos(off / 6);                            // 施工のうねり
  return d;
}

/** 法線ベクトル（横断形状の傾きから求める） */
function normalAt(off) {
  const eps = 0.01;
  const dh = (profileH(off + eps) - profileH(off - eps)) / (2 * eps);
  const len = Math.hypot(dh, 1);
  const cs = Math.cos(BEARING), sn = Math.sin(BEARING);
  // 断面内の法線 (オフセット方向 -dh, 鉛直 1) を世界座標へ
  return { e: (-dh / len) * -sn, n: (-dh / len) * cs, h: 1 / len };
}

function groundColor(off, shade) {
  const berm = off > 10.6 && off < 11.6;
  const base = berm ? [138, 132, 124] : [152, 140, 122];
  const k = 0.82 + shade * 0.3;
  return [
    Math.max(0, Math.min(255, base[0] * k)) | 0,
    Math.max(0, Math.min(255, base[1] * k)) | 0,
    Math.max(0, Math.min(255, base[2] * k)) | 0,
  ];
}

function allocate(n) {
  return {
    count: 0,
    e: new Float64Array(n), n: new Float64Array(n), h: new Float64Array(n),
    intensity: new Uint16Array(n), classification: new Uint8Array(n), rgb: new Uint8Array(n * 3),
  };
}

function push(p, e, n, h, cls, rgb, inten) {
  const i = p.count++;
  p.e[i] = e; p.n[i] = n; p.h[i] = h;
  p.classification[i] = cls;
  p.intensity[i] = inten;
  p.rgb[i * 3] = rgb[0]; p.rgb[i * 3 + 1] = rgb[1]; p.rgb[i * 3 + 2] = rgb[2];
}

// ---------------- 出来形点群 ----------------
console.log(`出来形点群を生成中… (${N_POST.toLocaleString()} 点)`);
const post = allocate(N_POST);
for (let i = 0; i < N_POST; i++) {
  const s = rnd() * LENGTH;
  const t = rnd() * ARC.total;
  const off = offsetAtArc(t);

  const r = rnd();
  if (r < 0.004) {
    // 植生（前処理で取り切れなかった残り）
    const nb = normalAt(off);
    const up = 0.3 + rnd() * 2.2;
    const w = toWorld(s, off);
    push(post, w.e + gauss() * 0.3, w.n + gauss() * 0.3, designH(s, off) + up,
      5, [60 + rnd() * 40 | 0, 95 + rnd() * 60 | 0, 45 + rnd() * 30 | 0], 2000 + rnd() * 4000 | 0);
    continue;
  }
  if (r < 0.0046) {
    // ノイズ点（鳥・粉塵など）
    const w = toWorld(s, off);
    push(post, w.e, w.n, designH(s, off) + 2 + rnd() * 12, 7, [200, 60, 60], 500);
    continue;
  }

  const dev = constructionError(s, off) + gauss() * 0.008; // 計測＋施工のばらつき σ=8mm
  const nb = normalAt(off);
  const w = toWorld(s, off);
  const shade = 0.5 + 0.35 * Math.sin(s / 7 + off / 3) + gauss() * 0.12;
  push(post,
    w.e + nb.e * dev, w.n + nb.n * dev, designH(s, off) + nb.h * dev,
    off > 10.6 && off < 11.6 ? 11 : 2,
    groundColor(off, shade),
    8000 + (shade * 20000) | 0);
}
console.log(`  → ${post.count.toLocaleString()} 点`);

// ---------------- 起工測量点群（施工前の地山） ----------------
console.log(`起工測量点群を生成中… (${N_PRE.toLocaleString()} 点)`);
const pre = allocate(N_PRE);
/** 施工前の地山は設計面より高い（＝切土する分） */
function preRise(s, off) {
  const along = 0.75 + 0.25 * Math.sin(s / 26 + 1.1);
  const across = Math.max(0, (off - OFF_MIN) / (OFF_MAX - OFF_MIN));
  return (1.2 + 7.0 * across ** 1.3) * along;
}
for (let i = 0; i < N_PRE; i++) {
  const s = rnd() * LENGTH;
  const off = OFF_MIN + rnd() * (OFF_MAX - OFF_MIN + 4);
  const w = toWorld(s, off);
  const base = designH(s, Math.min(off, OFF_MAX)) + preRise(s, off);
  if (rnd() < 0.05) {
    push(pre, w.e + gauss() * 0.4, w.n + gauss() * 0.4, base + 0.5 + rnd() * 4.5,
      5, [55 + rnd() * 45 | 0, 90 + rnd() * 70 | 0, 40 + rnd() * 35 | 0], 3000 + rnd() * 5000 | 0);
    continue;
  }
  const h = base + gauss() * 0.03;
  const shade = 0.5 + 0.3 * Math.sin(s / 9 + off / 4) + gauss() * 0.15;
  push(pre, w.e, w.n, h, 2,
    [Math.min(255, 120 * (0.85 + shade * 0.35)) | 0, Math.min(255, 118 * (0.85 + shade * 0.35)) | 0, Math.min(255, 100 * (0.85 + shade * 0.35)) | 0],
    6000 + (shade * 18000) | 0);
}
console.log(`  → ${pre.count.toLocaleString()} 点`);

// ---------------- 設計 TIN (LandXML) ----------------
console.log('設計 LandXML を生成中…');
const sSteps = [];
for (let s = 0; s <= LENGTH + 1e-9; s += 2) sSteps.push(s);
const offSteps = [];
for (let i = 0; i < PROFILE.length - 1; i++) {
  const [o1] = PROFILE[i], [o2] = PROFILE[i + 1];
  const n = Math.max(1, Math.ceil((o2 - o1) / 1.5));
  for (let k = 0; k < n; k++) offSteps.push(o1 + ((o2 - o1) * k) / n);
}
offSteps.push(OFF_MAX);

const pts = [];
for (let r = 0; r < sSteps.length; r++) {
  for (let c = 0; c < offSteps.length; c++) {
    const w = toWorld(sSteps[r], offSteps[c]);
    pts.push({ e: w.e, n: w.n, h: designH(sSteps[r], offSteps[c]) });
  }
}
const cols = offSteps.length;
const facesXml = [];
for (let r = 0; r < sSteps.length - 1; r++) {
  for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c + 1, b = a + 1, d = a + cols, e2 = d + 1;
    facesXml.push(`      <F>${a} ${d} ${b}</F>`);
    facesXml.push(`      <F>${b} ${d} ${e2}</F>`);
  }
}
// LandXML の <P> は「北 東 標高」の順
const pntsXml = pts.map((p, i) =>
  `      <P id="${i + 1}">${p.n.toFixed(4)} ${p.e.toFixed(4)} ${p.h.toFixed(4)}</P>`);

const today = new Date().toISOString().slice(0, 10);
const landxml = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="${today}" time="00:00:00">
  <Units>
    <Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" directionUnit="decimal degrees"/>
  </Units>
  <CoordinateSystem name="${escapeXml('平面直角座標系 第II系 (JGD2011)')}" epsgCode="6670" horizontalDatum="JGD2011"/>
  <Project name="${escapeXml('【サンプル】市道○○線 法面工事')}"/>
  <Application name="tengun make-sample" version="0.1.0"/>
  <Surfaces>
    <Surface name="${escapeXml('設計面（切土のり面）')}" desc="${escapeXml('小段付き 1:1.2 切土のり面')}">
      <Definition surfType="TIN">
        <Pnts>
${pntsXml.join('\n')}
        </Pnts>
        <Faces>
${facesXml.join('\n')}
        </Faces>
      </Definition>
    </Surface>
  </Surfaces>
</LandXML>
`;

// ---------------- 工事情報 ----------------
const info = {
  "$comment": "工事情報。座標系は LAS ヘッダに入っていないことが多いので、ここで明示的に指定する（推測しない）。",
  projectName: '【サンプル】市道○○線 道路改良工事（切土のり面）',
  projectNumber: 'SAMPLE-2026-001',
  owner: '鹿児島市（サンプル）',
  contractor: '葉月工業株式会社（サンプル）',
  startDate: '2026-04-01',
  endDate: '2026-11-30',
  workType: 'doro-dokou-rotai',
  epsg: 6670,
  axisOrder: 'EN',
  "$axisOrderNote": "LAS の X/Y の並び。EN = X が東・Y が北（一般的な LAS）。NE = X が北・Y が東（測量座標をそのまま入れた場合）。",
  design: { file: '設計.xml', pointOrder: 'NEH' },
  acquisition: {
    post: { capturedAt: '2026-10-20', equipment: '（サンプル）UAVレーザ', software: '（サンプル）', note: '草木除去等の前処理済み想定' },
    pre: { capturedAt: '2026-04-10', equipment: '（サンプル）UAV写真測量', software: '（サンプル）' }
  },
  note: 'これは合成サンプルデータです。検査には使用できません。'
};

// ---------------- 書き出し ----------------
console.log('ファイル書き出し中…');
const files = [
  ['出来形.las', writeLas(post, { generatingSoftware: 'tengun sample' })],
  ['起工測量.las', writeLas(pre, { generatingSoftware: 'tengun sample' })],
  ['設計.xml', Buffer.from(landxml, 'utf8')],
  ['工事情報.json', Buffer.from(JSON.stringify(info, null, 2), 'utf8')],
];
for (const [name, data] of files) {
  writeFileSync(join(OUT, name), data);
  console.log(`  ${name}  ${(data.length / 1048576).toFixed(1)} MB`);
}
console.log(`\n完了: ${OUT}/`);
