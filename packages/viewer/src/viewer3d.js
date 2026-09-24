/**
 * シーン管理と LOD。
 * 座標は「ローカル原点からの相対 m」。x=東 / y=北 / z=上。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createPointMaterial, makeNodeObject, makeDesignMesh, MODE } from './render.js';

const MIN_NODE_PIXELS = 48;
const MAX_CONCURRENT_LOADS = 6;

export class Viewer3D {
  constructor(container, { defaults, maxPoints = 6_000_000 }) {
    this.container = container;
    this.maxPoints = maxPoints;
    this.loadedPoints = 0;
    this.datasets = new Map();
    this.activeId = null;
    this.pending = 0;
    this.needsVisibilityUpdate = true;
    this.onStatus = () => {};

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // 画面の背景（CSS の --bg）と揃える。ずれるとキャンバスの縁が見えてしまう。
    this.renderer.setClearColor(0xeaeef0, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.material = createPointMaterial();
    this.material.uniforms.uDevRange.value.set(-defaults.colorRangeM, defaults.colorRangeM);
    this.material.uniforms.uTolerance.value = defaults.toleranceM;
    this.material.uniformsNeedUpdate = true;

    this.groups = new THREE.Group();
    this.scene.add(this.groups);
    this.designGroup = new THREE.Group();
    this.scene.add(this.designGroup);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);

    this.perspective = new THREE.PerspectiveCamera(55, 1, 0.5, 20000);
    this.perspective.up.set(0, 0, 1);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 20000);
    this.ortho.up.set(0, 1, 0);
    this.camera = this.ortho;

    this.controls = null;
    this.mode = 'plan';

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._raf = null;
    this._lastFrame = performance.now();
    this.fps = 0;
  }

  addDataset(ds) {
    const group = new THREE.Group();
    group.visible = false;
    this.groups.add(group);
    this.datasets.set(ds.id, { ds, group, objects: new Map() });
    if (this.activeId === null) this.setActiveDataset(ds.id);
  }

  setActiveDataset(id) {
    this.activeId = id;
    for (const [k, v] of this.datasets) v.group.visible = k === id;
    this.needsVisibilityUpdate = true;
  }

  get active() { return this.datasets.get(this.activeId); }

  setDesign(design) {
    this.designGroup.clear();
    if (design) this.designGroup.add(makeDesignMesh(design));
  }
  setDesignVisible(v) { this.designGroup.visible = v; }

  /** 全データの外接範囲（ローカル座標） */
  computeBounds() {
    const box = new THREE.Box3();
    for (const { ds } of this.datasets.values()) {
      const b = ds.hierarchy.nodes.find((n) => n.name === 'r');
      if (!b) continue;
      box.expandByPoint(new THREE.Vector3(...b.min));
      box.expandByPoint(new THREE.Vector3(...b.max));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    return box;
  }

  /** 初期表示は真上からの正射投影（平面図）。3D 操作に不慣れな人が最初に見る画面。 */
  frameAll() {
    const box = this.computeBounds();
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    this.siteCenter = center.clone();
    this.siteSize = size.clone();

    this._setUniform((u) => { u.uElevRange.value.set(box.min.z, box.max.z); });

    this.ortho.position.set(center.x, center.y, box.max.z + Math.max(size.x, size.y) + 100);
    this.orthoTarget = new THREE.Vector3(center.x, center.y, center.z);
    this.orthoViewSize = Math.max(size.x, size.y) * 1.12;

    // 3D の初期視点。遠すぎると法面が平らに見えるので、やや寄って低めの角度から見る
    const dist = Math.max(size.x, size.y, size.z) * 0.85;
    this.perspective.position.set(center.x - dist * 0.62, center.y - dist * 0.72, center.z + dist * 0.42);
    this.perspectiveTarget = center.clone();

    this.setViewMode(this.mode);
    this.resize();
  }

  setViewMode(mode) {
    this.mode = mode;
    const el = this.renderer.domElement;
    if (this.controls) { this.controls.dispose(); this.controls = null; }

    if (mode === 'plan') {
      this.camera = this.ortho;
      this.camera.up.set(0, 1, 0);
      this.controls = new OrbitControls(this.ortho, el);
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.controls.target.copy(this.orthoTarget);
      this.ortho.position.set(this.orthoTarget.x, this.orthoTarget.y, this.orthoTarget.z + 5000);
      this._setUniform((u) => { u.uAdaptive.value = 0; });
    } else {
      this.camera = this.perspective;
      this.camera.up.set(0, 0, 1);
      this.controls = new OrbitControls(this.perspective, el);
      this.controls.enableRotate = true;
      // 地面より下に潜ると何も見えなくなるので、水平より下へは回さない
      this.controls.maxPolarAngle = Math.PI * 0.495;
      this.controls.target.copy(this.perspectiveTarget);
      this._setUniform((u) => { u.uAdaptive.value = 1; });
    }
    // 3D は 左=回転 / 右=平行移動。
    // 平面図は回転しないので、左ドラッグも平行移動にする。
    // 地図と同じ操作感にしないと「左で掴んでも動かない」と戸惑わせる。
    this.controls.mouseButtons = mode === 'plan'
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    el.classList.toggle('mode-3d', mode !== 'plan');
    el.classList.toggle('mode-plan', mode === 'plan');
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    // 掴んでいる最中が分かるようカーソルを変える
    this.controls.addEventListener('start', () => el.classList.add('dragging'));
    this.controls.addEventListener('end', () => el.classList.remove('dragging'));
    this.controls.addEventListener('change', () => { this.needsVisibilityUpdate = true; });
    this.resize();
    this.needsVisibilityUpdate = true;
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    const half = (this.orthoViewSize ?? 100) / 2;
    this.ortho.left = -half * aspect; this.ortho.right = half * aspect;
    this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
    this.material.uniforms.uProjFactor.value = h / (2 * Math.tan((this.perspective.fov * Math.PI) / 360));
    this.material.uniformsNeedUpdate = true;
    this.needsVisibilityUpdate = true;
  }

  // ---- LOD ----
  _projectedPixels(node) {
    const h = this.container.clientHeight || 1;
    const size = node.cube[3];
    if (this.camera === this.ortho) {
      return (size / (this.ortho.top - this.ortho.bottom)) * h * this.ortho.zoom;
    }
    const center = new THREE.Vector3(
      node.cube[0] + size / 2, node.cube[1] + size / 2, node.cube[2] + size / 2
    );
    const dist = Math.max(0.001, center.distanceTo(this.perspective.position));
    return (size / dist) * this.material.uniforms.uProjFactor.value;
  }

  updateVisibility() {
    const entry = this.active;
    if (!entry) return;
    this.camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
    );

    const queue = [];
    const visible = new Set();
    const stack = [entry.ds.root];
    const box = new THREE.Box3();

    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      box.set(
        new THREE.Vector3(node.cube[0], node.cube[1], node.cube[2]),
        new THREE.Vector3(node.cube[0] + node.cube[3], node.cube[1] + node.cube[3], node.cube[2] + node.cube[3])
      );
      if (!frustum.intersectsBox(box)) continue;
      const px = this._projectedPixels(node);
      if (node.level > 0 && px < MIN_NODE_PIXELS) continue;

      visible.add(node.name);
      if (!node.loaded && !node.loading) queue.push({ node, px });
      for (const c of node.children) stack.push(c);
    }

    for (const [name, obj] of entry.objects) obj.visible = visible.has(name);

    queue.sort((a, b) => b.px - a.px);
    this._enqueue(entry, queue);
    this.visibleNodeCount = visible.size;
  }

  async _enqueue(entry, queue) {
    for (const { node } of queue) {
      if (this.pending >= MAX_CONCURRENT_LOADS) break;
      if (this.loadedPoints + node.pointCount > this.maxPoints) continue;
      node.loading = true;
      this.pending++;
      entry.ds.fetchNode(node)
        .then((buf) => {
          const decoded = entry.ds.decode(buf, node);
          node.cpu = decoded;
          // ノードの点間隔 = 根の間隔 / 2^階層
          const spacing = (entry.ds.hierarchy.spacing ?? 1) / Math.pow(2, node.level);
          const obj = makeNodeObject(decoded, this.material, spacing);
          entry.group.add(obj);
          entry.objects.set(node.name, obj);
          node.loaded = true;
          this.loadedPoints += node.pointCount;
        })
        .catch((err) => { node.error = err.message; console.error('ノード読み込み失敗', node.name, err); })
        .finally(() => { node.loading = false; this.pending--; this.needsVisibilityUpdate = true; });
    }
  }

  start() {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.controls?.update();
      if (this.needsVisibilityUpdate) { this.needsVisibilityUpdate = false; this.updateVisibility(); }
      this.renderer.render(this.scene, this.camera);
      const now = performance.now();
      this.fps = this.fps * 0.9 + (1000 / Math.max(1, now - this._lastFrame)) * 0.1;
      this._lastFrame = now;
      this.onStatus(this.statusSnapshot());
    };
    loop();
  }

  /** 画面 1px あたりの現地距離 (m)。平面図（正射投影）でのみ意味を持つ。 */
  worldPerPixel() {
    if (this.camera !== this.ortho) return NaN;
    const h = this.container.clientHeight || 1;
    return (this.ortho.top - this.ortho.bottom) / h / this.ortho.zoom;
  }

  statusSnapshot() {
    const mem = performance.memory
      ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) }
      : null;
    return {
      loadedPoints: this.loadedPoints,
      visibleNodes: this.visibleNodeCount ?? 0,
      pending: this.pending,
      fps: this.fps,
      memory: mem,
      drawCalls: this.renderer.info.render.calls,
    };
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.controls?.dispose();
    this.renderer.dispose();
  }

  // ---- 操作系 ----
  /**
   * ユニフォームを変える。
   *
   * 【重要】three.js は同じマテリアルを使い回す描画でユニフォームを再送しない。
   * uniforms.X.value を書き換えただけでは画面に反映されないので、
   * 必ず uniformsNeedUpdate を立てること。これを忘れると
   * 「色分けを変えても何も起きない」状態になる。
   */
  _setUniform(fn) {
    fn(this.material.uniforms);
    this.material.uniformsNeedUpdate = true;
  }

  setColorMode(m) { this._setUniform((u) => { u.uMode.value = m; }); }
  setPointSize(v) { this._setUniform((u) => { u.uPointSize.value = v; }); }
  setRoundPoints(v) { this._setUniform((u) => { u.uRound.value = v ? 1 : 0; }); }
  setDevRange(m) { this._setUniform((u) => { u.uDevRange.value.set(-m, m); }); }
  setHighlightOut(v) { this._setUniform((u) => { u.uHighlightOut.value = v ? 1 : 0; }); }
  setUseAltMeasure(v) { this._setUniform((u) => { u.uUseAlt.value = v ? 1 : 0; }); }
  setGroundOnly(v) { this._setUniform((u) => { u.uGroundOnly.value = v ? 1 : 0; }); }

  /** 画面座標 → 現場の代表標高面上のローカル座標 */
  screenToWorld(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(this.siteCenter?.z ?? 0));
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, hit) ? hit : null;
  }

  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height };
  }

  /** 読み込み済みノードから測線近傍の点を集める（断面図用） */
  gatherAlongLine(a, b, halfWidth) {
    const entry = this.active;
    if (!entry) return { count: 0 };
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { count: 0 };
    const ux = dx / len, uy = dy / len;

    const useAlt = this.material.uniforms.uUseAlt.value > 0.5;
    const groundOnly = this.material.uniforms.uGroundOnly.value > 0.5;
    const es = [], ns = [], hs = [], ds = [];
    for (const node of entry.ds.byName.values()) {
      if (!node.loaded || !node.cpu) continue;
      // ノード bbox が測線帯から外れていれば飛ばす
      const [nx0, ny0] = node.min, [nx1, ny1] = node.max;
      if (Math.max(nx0, nx1) < Math.min(a.x, b.x) - halfWidth - 1) continue;
      if (Math.min(nx0, nx1) > Math.max(a.x, b.x) + halfWidth + 1) continue;
      if (Math.max(ny0, ny1) < Math.min(a.y, b.y) - halfWidth - 1) continue;
      if (Math.min(ny0, ny1) > Math.max(a.y, b.y) + halfWidth + 1) continue;

      const { pos, count } = node.cpu;
      const dev = useAlt ? (node.cpu.devAlt ?? node.cpu.dev) : node.cpu.dev;
      const valid = useAlt ? (node.cpu.validAlt ?? node.cpu.valid) : node.cpu.valid;
      const cls = node.cpu.cls;
      for (let i = 0; i < count; i++) {
        if (groundOnly && cls[i] !== 2 && cls[i] !== 11) continue;
        const px = pos[i * 3], py = pos[i * 3 + 1];
        const re = px - a.x, rn = py - a.y;
        const t = re * ux + rn * uy;
        if (t < 0 || t > len) continue;
        if (Math.abs(-re * uy + rn * ux) > halfWidth) continue;
        es.push(px); ns.push(py); hs.push(pos[i * 3 + 2]);
        ds.push(valid[i] ? dev[i] : NaN);
      }
    }
    return {
      count: es.length,
      e: Float64Array.from(es), n: Float64Array.from(ns), h: Float64Array.from(hs),
      deviation: Float32Array.from(ds),
    };
  }

  drawLineOverlay(a, b) {
    this.overlay.clear();
    if (!a || !b) return;
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.x, a.y, (this.siteCenter?.z ?? 0) + this.siteSize.z),
      new THREE.Vector3(b.x, b.y, (this.siteCenter?.z ?? 0) + this.siteSize.z),
    ]);
    this.overlay.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x1f6feb, linewidth: 2 })));
  }
}

export { MODE };
