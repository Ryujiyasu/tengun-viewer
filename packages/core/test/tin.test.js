import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TinSurface } from '../src/tin.js';
import { parseLandXml } from '../src/landxml.js';

/** 1:1.2 勾配の平面 TIN を作る（東西方向に水平、南北方向に下る斜面） */
function makeSlopeTin(slope = 1 / 1.2, size = 60, step = 5) {
  const es = [], ns = [], hs = [];
  const cols = size / step + 1;
  for (let r = 0; r <= size / step; r++) {
    for (let c = 0; c <= size / step; c++) {
      es.push(c * step);
      ns.push(r * step);
      hs.push(100 - r * step * slope);
    }
  }
  const faces = [];
  for (let r = 0; r < size / step; r++) {
    for (let c = 0; c < size / step; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e2 = d + 1;
      faces.push(a, b, d, b, e2, d);
    }
  }
  return new TinSurface({
    e: Float64Array.from(es), n: Float64Array.from(ns), h: Float64Array.from(hs),
    faces: Int32Array.from(faces), name: 'slope',
  });
}

test('法線が上向きに揃い、傾斜角が正しい', () => {
  const tin = makeSlopeTin();
  for (let i = 0; i < tin.triCount; i++) assert.ok(tin.nz[i] > 0, '法線が上向きでない');
  const expected = Math.atan(1 / 1.2) * 180 / Math.PI;
  assert.ok(Math.abs(tin.slopeDeg(0) - expected) < 1e-9, `傾斜角 ${tin.slopeDeg(0)} != ${expected}`);
});

test('法線方向に既知量ずらした点の較差が解析解と一致する', () => {
  const tin = makeSlopeTin();
  const nx = tin.nx[0], ny = tin.ny[0], nz = tin.nz[0];
  for (const offset of [0.05, -0.05, 0.123, -0.031, 0]) {
    // 面の内側（境界から十分離れた位置）を選ぶ
    const be = 30, bn = 30, bh = 100 - 30 * (1 / 1.2);
    const r = tin.closest(be + nx * offset, bn + ny * offset, bh + nz * offset);
    assert.ok(r, '最近傍が見つからない');
    assert.ok(Math.abs(r.deviation - offset) < 1e-9,
      `較差 ${r.deviation} が期待値 ${offset} と一致しない`);
  }
});

test('鉛直較差ではなく法線方向較差であること', () => {
  // 鉛直に 0.1m 上げた点は、勾配 1:1.2 の面では法線方向較差が 0.1*cosθ になる
  const tin = makeSlopeTin();
  const bh = 100 - 30 * (1 / 1.2);
  const r = tin.closest(30, 30, bh + 0.1);
  const cosTheta = tin.nz[0];
  assert.ok(Math.abs(r.deviation - 0.1 * cosTheta) < 1e-9,
    `法線方向較差 ${r.deviation} != ${0.1 * cosTheta}（鉛直較差と取り違えている）`);
  assert.ok(r.deviation < 0.1, '鉛直較差をそのまま返している');
});

test('符号は設計面より高い側が正', () => {
  const tin = makeSlopeTin();
  const bh = 100 - 30 * (1 / 1.2);
  assert.ok(tin.closest(30, 30, bh + 0.2).deviation > 0, '上側が正になっていない');
  assert.ok(tin.closest(30, 30, bh - 0.2).deviation < 0, '下側が負になっていない');
});

test('設計面の範囲外は null', () => {
  const tin = makeSlopeTin();
  assert.equal(tin.closest(5000, 5000, 100, 5), null);
});

test('真上からの設計面標高（elevationAt）', () => {
  const tin = makeSlopeTin();
  assert.ok(Math.abs(tin.elevationAt(30, 30) - (100 - 30 / 1.2)) < 1e-9);
  assert.ok(Math.abs(tin.elevationAt(12.5, 7.5) - (100 - 7.5 / 1.2)) < 1e-9);
  assert.ok(Number.isNaN(tin.elevationAt(-100, -100)));
});

test('LandXML の座標順は北 東 標高', () => {
  const xml = `<?xml version="1.0"?>
<LandXML version="1.2" xmlns="http://www.landxml.org/schema/LandXML-1.2">
  <Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" angularUnit="decimal degrees"/></Units>
  <Surfaces><Surface name="設計面">
    <Definition surfType="TIN">
      <Pnts>
        <P id="1">-155500.000 -42000.000 100.000</P>
        <P id="2">-155500.000 -41990.000 100.000</P>
        <P id="3">-155490.000 -42000.000 95.000</P>
        <P id="4">-155490.000 -41990.000 95.000</P>
      </Pnts>
      <Faces><F>1 2 3</F><F>2 4 3</F><F i="1">1 2 3</F></Faces>
    </Definition>
  </Surface></Surfaces>
</LandXML>`;
  const doc = parseLandXml(xml);
  const s = doc.surfaces[0];
  assert.equal(s.name, '設計面');
  assert.equal(s.pointCount, 4);
  assert.equal(s.count, 2, '不可視面 i="1" が除外されていない');
  // P の 1 番目が北(n)、2 番目が東(e)
  assert.equal(s.n[0], -155500.000);
  assert.equal(s.e[0], -42000.000);
  assert.equal(s.h[0], 100.0);
});

test('LandXML の単位が非メートルなら拒否する', () => {
  const xml = `<LandXML version="1.2"><Units><Imperial linearUnit="foot"/></Units>
  <Surfaces><Surface name="x"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P></Pnts><Faces><F>1 1 1</F></Faces></Definition></Surface></Surfaces></LandXML>`;
  assert.throws(() => parseLandXml(xml), /ヤード・ポンド法/);
});
