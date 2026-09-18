/**
 * three.js による点群描画。
 *
 * 【要注意】点群の座標は平面直角座標系の生値（-155,500 など）。
 * GPU に渡す前に必ずローカル原点へ平行移動してある（CLI 側で origin を引いてある）。
 * float32 のまま生値を渡すと mm 単位が丸め落ちて描画が壊れる。
 */
import * as THREE from 'three';
import { GLSL_RAMPS } from './colors.js';

export const MODE = { RGB: 0, ELEVATION: 1, INTENSITY: 2, CLASSIFICATION: 3, DEVIATION: 4 };

const VERT = `
precision highp float;
attribute vec3 aColor;
attribute float aDev;
attribute float aDevAlt;
attribute float aValidAlt;
attribute float aClass;
attribute float aInt;
attribute float aValid;

uniform int   uMode;
uniform float uPointSize;
uniform float uAdaptive;
uniform float uProjFactor;
uniform float uSpacing;
uniform float uGroundOnly;
uniform vec2  uDevRange;
uniform vec2  uElevRange;
uniform float uHighlightOut;
uniform float uUseAlt;
uniform float uTolerance;
uniform float uOpacity;

varying vec3 vColor;
varying float vDiscard;

${GLSL_RAMPS}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // 遠近法のときは、そのノードの点間隔を画面に投影した大きさを基準にする。
  // 点間隔を掛けずに距離で割ると、近づいたときに点が数十 px まで肥大して
  // 画面が単色に潰れる。
  // オクツリーは親ノードに粗い間引き点、子ノードに残りを持たせる方式なので、
  // 同じ画面に点間隔の違うノードが混ざる。間隔どおりの大きさで描くと粗い階層が
  // 数十 px の四角になって画面を覆うため、上限を低めに抑える。
  float size = uPointSize;
  if (uAdaptive > 0.5) {
    size = clamp(uPointSize * uSpacing * uProjFactor / max(-mv.z, 0.001), 1.0, 7.0);
  }
  gl_PointSize = size;

  // 判定は地表面(分類 2, 11)だけで行う。表示も同じ範囲に絞れるようにする。
  // 除去しきれなかった草木が浮いて見えるのを消せる。
  vDiscard = 0.0;
  if (uGroundOnly > 0.5) {
    int k = int(aClass + 0.5);
    if (k != 2 && k != 11) { vDiscard = 1.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
  }
  if (uMode == 0) {
    vColor = aColor;
  } else if (uMode == 1) {
    vColor = rampElevation((position.z - uElevRange.x) / max(uElevRange.y - uElevRange.x, 0.001));
  } else if (uMode == 2) {
    vColor = vec3(0.15 + aInt * 0.85);
  } else if (uMode == 3) {
    vColor = classColor(aClass);
  } else {
    float d  = uUseAlt > 0.5 ? aDevAlt : aDev;
    float ok = uUseAlt > 0.5 ? aValidAlt : aValid;
    if (ok < 0.5) {
      vColor = vec3(0.70, 0.72, 0.74);
    } else {
      float t = (d - uDevRange.x) / max(uDevRange.y - uDevRange.x, 0.0001);
      vColor = rampDeviation(t);
      if (uHighlightOut > 0.5 && abs(d) <= uTolerance) vColor = mix(vColor, vec3(0.86, 0.87, 0.88), 0.82);
    }
  }
}
`;

const FRAG = `
precision highp float;
varying vec3 vColor;
varying float vDiscard;
uniform float uRound;
uniform float uOpacity;
void main() {
  if (vDiscard > 0.5) discard;
  if (uRound > 0.5) {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
  }
  gl_FragColor = vec4(vColor, uOpacity);
}
`;

export function createPointMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uMode: { value: MODE.DEVIATION },
      uPointSize: { value: 2.0 },
      uAdaptive: { value: 0.0 },
      uProjFactor: { value: 1.0 },
      uSpacing: { value: 1.0 },
      uGroundOnly: { value: 0.0 },
      uDevRange: { value: new THREE.Vector2(-0.05, 0.05) },
      uElevRange: { value: new THREE.Vector2(0, 1) },
      uHighlightOut: { value: 0.0 },
      uUseAlt: { value: 0.0 },
      uTolerance: { value: 0.05 },
      uRound: { value: 0.0 },
      uOpacity: { value: 1.0 },
    },
    transparent: false,
  });
}

/**
 * @param spacing このノードが担当する点間隔 (m)。遠近法のときの点サイズに使う。
 */
export function makeNodeObject(decoded, material, spacing = 1.0) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(decoded.pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(decoded.col, 3, true));
  g.setAttribute('aDev', new THREE.BufferAttribute(decoded.dev, 1));
  g.setAttribute('aDevAlt', new THREE.BufferAttribute(decoded.devAlt ?? decoded.dev, 1));
  g.setAttribute('aValidAlt', new THREE.BufferAttribute(decoded.validAlt ?? decoded.valid, 1));
  g.setAttribute('aClass', new THREE.BufferAttribute(decoded.cls, 1));
  g.setAttribute('aInt', new THREE.BufferAttribute(decoded.inten, 1));
  g.setAttribute('aValid', new THREE.BufferAttribute(decoded.valid, 1));
  g.computeBoundingSphere();
  const pts = new THREE.Points(g, material);
  pts.frustumCulled = false;
  pts.userData.spacing = spacing;
  // 材質は全ノードで共有しているので、描画直前にそのノードの点間隔へ差し替える
  pts.onBeforeRender = (renderer, scene, camera, geometry, mat) => {
    // ノードごとに値が変わるので、毎回 uniformsNeedUpdate を立てて送り直す
    mat.uniforms.uSpacing.value = spacing;
    mat.uniformsNeedUpdate = true;
  };
  return pts;
}

export function makeDesignMesh(design) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(design.pos, 3));
  g.setIndex(new THREE.BufferAttribute(design.idx, 1));
  g.computeVertexNormals();
  // 設計面は点群とほぼ同じ位置にあるため、深度テストを効かせると点に隠れて見えない。
  // 参照用の重ね描きなので、常に手前に描く。
  const m = new THREE.MeshBasicMaterial({
    color: 0xc0392b, wireframe: true, transparent: true, opacity: 0.45,
    depthWrite: false, depthTest: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 10;
  return mesh;
}
