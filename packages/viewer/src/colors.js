/** 配色。印刷・白黒コピーでも差が残るよう、明度差のあるランプを使う。 */

/** 較差用の発散配色（ColorBrewer RdBu 系）。負=青（削り）/ 正=赤（盛り） */
export const DEVIATION_STOPS = [
  [0.0, [0.129, 0.400, 0.675]],
  [0.25, [0.404, 0.663, 0.812]],
  [0.5, [0.969, 0.969, 0.969]],
  [0.75, [0.937, 0.541, 0.384]],
  [1.0, [0.698, 0.094, 0.169]],
];

/** 標高用（地形図に近い配色） */
export const ELEVATION_STOPS = [
  [0.0, [0.180, 0.365, 0.510]],
  [0.25, [0.302, 0.600, 0.494]],
  [0.5, [0.804, 0.788, 0.478]],
  [0.75, [0.741, 0.545, 0.333]],
  [1.0, [0.965, 0.961, 0.949]],
];

export function sampleRamp(stops, t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (x <= b) {
      const f = (x - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

export function rampCss(stops, t) {
  const c = sampleRamp(stops, t);
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

/** 較差(m) → CSS 色。range は片側の m。無効値は灰色。 */
export function deviationCss(devM, rangeM) {
  if (devM === null || devM === undefined || Number.isNaN(devM)) return '#b3b8bd';
  return rampCss(DEVIATION_STOPS, (devM / rangeM + 1) / 2);
}

export const CLASS_COLORS = {
  0: [0.62, 0.65, 0.68], 1: [0.72, 0.74, 0.76],
  2: [0.65, 0.53, 0.40], 3: [0.55, 0.72, 0.42], 4: [0.40, 0.62, 0.33], 5: [0.25, 0.48, 0.25],
  6: [0.80, 0.45, 0.40], 7: [0.90, 0.25, 0.25], 9: [0.30, 0.55, 0.85],
  11: [0.45, 0.45, 0.48], 13: [0.85, 0.70, 0.30], 17: [0.70, 0.55, 0.85],
};

export const CLASS_NAMES = {
  0: '未分類', 1: '未割当', 2: '地表面', 3: '低植生', 4: '中植生', 5: '高植生',
  6: '建物', 7: 'ノイズ', 9: '水面', 11: '路面', 13: 'ガードレール', 17: '橋梁',
};

/** GLSL 側で使う発散配色（頂点シェーダに埋め込む） */
export const GLSL_RAMPS = `
vec3 rampDeviation(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.129, 0.400, 0.675);
  vec3 c1 = vec3(0.404, 0.663, 0.812);
  vec3 c2 = vec3(0.969, 0.969, 0.969);
  vec3 c3 = vec3(0.937, 0.541, 0.384);
  vec3 c4 = vec3(0.698, 0.094, 0.169);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
vec3 rampElevation(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.180, 0.365, 0.510);
  vec3 c1 = vec3(0.302, 0.600, 0.494);
  vec3 c2 = vec3(0.804, 0.788, 0.478);
  vec3 c3 = vec3(0.741, 0.545, 0.333);
  vec3 c4 = vec3(0.965, 0.961, 0.949);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
vec3 classColor(float c) {
  int k = int(c + 0.5);
  if (k == 2) return vec3(0.65, 0.53, 0.40);
  if (k == 3) return vec3(0.55, 0.72, 0.42);
  if (k == 4) return vec3(0.40, 0.62, 0.33);
  if (k == 5) return vec3(0.25, 0.48, 0.25);
  if (k == 6) return vec3(0.80, 0.45, 0.40);
  if (k == 7) return vec3(0.90, 0.25, 0.25);
  if (k == 9) return vec3(0.30, 0.55, 0.85);
  if (k == 11) return vec3(0.45, 0.45, 0.48);
  if (k == 13) return vec3(0.85, 0.70, 0.30);
  if (k == 17) return vec3(0.70, 0.55, 0.85);
  if (k == 1) return vec3(0.72, 0.74, 0.76);
  return vec3(0.62, 0.65, 0.68);
}
`;
