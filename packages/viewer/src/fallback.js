/**
 * WebGL2 が使えない環境向けの Canvas 2D モード。
 * 3D は諦めても、平面図・較差カラーマップ・断面図・帳票は見られる状態を守る。
 */
import { deviationCss, sampleRamp, ELEVATION_STOPS, CLASS_COLORS } from './colors.js';

export class Fallback2D {
  constructor(container, { defaults }) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fallback-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.points = null;
    this.rangeM = defaults.colorRangeM;
    this.mode = 'deviation';
    this.groundOnly = false;
    this.pointSize = 2;
    this.view = { cx: 0, cy: 0, scale: 1 };
    this._bindPanZoom();
    window.addEventListener('resize', () => this.draw());
  }

  /** ノードから CPU 配列を集約して保持する（点数は上限で打ち切る） */
  setPoints(chunks, maxPoints = 1_200_000) {
    let total = 0;
    for (const c of chunks) total += c.count;
    const n = Math.min(total, maxPoints);
    const step = Math.max(1, Math.ceil(total / n));
    const pos = new Float32Array(n * 3), dev = new Float32Array(n), cls = new Float32Array(n), col = new Uint8Array(n * 3), valid = new Float32Array(n);
    let w = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.count && w < n; i += step, w++) {
        pos[w * 3] = c.pos[i * 3]; pos[w * 3 + 1] = c.pos[i * 3 + 1]; pos[w * 3 + 2] = c.pos[i * 3 + 2];
        dev[w] = c.dev[i]; cls[w] = c.cls[i]; valid[w] = c.valid[i];
        col[w * 3] = c.col[i * 3]; col[w * 3 + 1] = c.col[i * 3 + 1]; col[w * 3 + 2] = c.col[i * 3 + 2];
      }
    }
    this.points = { pos, dev, cls, col, valid, count: w };
    this._computeBounds();
    this.fit();
  }

  _computeBounds() {
    const p = this.points;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const x = p.pos[i * 3], y = p.pos[i * 3 + 1], z = p.pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    this.bounds = { minX, maxX, minY, maxY, minZ, maxZ };
  }

  fit() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const b = this.bounds;
    this.view.scale = Math.min(w / Math.max(b.maxX - b.minX, 1e-3), h / Math.max(b.maxY - b.minY, 1e-3)) * 0.9;
    this.view.cx = (b.minX + b.maxX) / 2;
    this.view.cy = (b.minY + b.maxY) / 2;
    this.draw();
  }

  _bindPanZoom() {
    let dragging = false, lx = 0, ly = 0;
    this.canvas.addEventListener('mousedown', (e) => { if (e.button === 2 || e.button === 0) { dragging = true; lx = e.clientX; ly = e.clientY; } });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.view.cx -= (e.clientX - lx) / this.view.scale;
      this.view.cy += (e.clientY - ly) / this.view.scale;
      lx = e.clientX; ly = e.clientY;
      this.draw();
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.draw();
    }, { passive: false });
  }

  toScreen(x, y) {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    return [(x - this.view.cx) * this.view.scale + w / 2, h / 2 - (y - this.view.cy) * this.view.scale];
  }

  toWorld(sx, sy) {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    return { x: (sx - w / 2) / this.view.scale + this.view.cx, y: this.view.cy - (sy - h / 2) / this.view.scale };
  }

  draw() {
    if (!this.points) return;
    const dpr = this.dpr = Math.min(window.devicePixelRatio, 2);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#eaeef0';
    ctx.fillRect(0, 0, w, h);

    const p = this.points;
    const size = this.pointSize;
    const b = this.bounds;
    // 同じ色の点をまとめて描くと速い
    const buckets = new Map();
    for (let i = 0; i < p.count; i++) {
      if (this.groundOnly && p.cls[i] !== 2 && p.cls[i] !== 11) continue;
      const [sx, sy] = this.toScreen(p.pos[i * 3], p.pos[i * 3 + 1]);
      if (sx < -5 || sy < -5 || sx > w + 5 || sy > h + 5) continue;
      let color;
      if (this.mode === 'deviation') color = p.valid[i] ? deviationCss(p.dev[i], this.rangeM) : '#b3b8bd';
      else if (this.mode === 'elevation') {
        const c = sampleRamp(ELEVATION_STOPS, (p.pos[i * 3 + 2] - b.minZ) / Math.max(b.maxZ - b.minZ, 1e-3));
        color = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
      } else if (this.mode === 'classification') {
        const c = CLASS_COLORS[p.cls[i]] ?? CLASS_COLORS[0];
        color = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
      } else {
        color = `rgb(${p.col[i * 3]},${p.col[i * 3 + 1]},${p.col[i * 3 + 2]})`;
      }
      let arr = buckets.get(color);
      if (!arr) { arr = []; buckets.set(color, arr); }
      arr.push(sx, sy);
    }
    for (const [color, arr] of buckets) {
      ctx.fillStyle = color;
      for (let i = 0; i < arr.length; i += 2) ctx.fillRect(arr[i], arr[i + 1], size, size);
    }

    if (this.line) {
      ctx.strokeStyle = '#1f6feb'; ctx.lineWidth = 2;
      const a = this.toScreen(this.line.a.x, this.line.a.y), c = this.toScreen(this.line.b.x, this.line.b.y);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
    }
  }

  gatherAlongLine(a, b, halfWidth) {
    const p = this.points;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6 || !p) return { count: 0 };
    const ux = dx / len, uy = dy / len;
    const es = [], ns = [], hs = [], ds = [];
    for (let i = 0; i < p.count; i++) {
      if (this.groundOnly && p.cls[i] !== 2 && p.cls[i] !== 11) continue;
      const re = p.pos[i * 3] - a.x, rn = p.pos[i * 3 + 1] - a.y;
      const t = re * ux + rn * uy;
      if (t < 0 || t > len) continue;
      if (Math.abs(-re * uy + rn * ux) > halfWidth) continue;
      es.push(p.pos[i * 3]); ns.push(p.pos[i * 3 + 1]); hs.push(p.pos[i * 3 + 2]);
      ds.push(p.valid[i] ? p.dev[i] : NaN);
    }
    return { count: es.length, e: Float64Array.from(es), n: Float64Array.from(ns), h: Float64Array.from(hs), deviation: Float32Array.from(ds) };
  }
}
