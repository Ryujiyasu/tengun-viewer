/**
 * octree データの読み込み。
 *  full  : 静的ファイルへ Range リクエスト（閉域 Web サーバ配置）
 *  light : HTML に埋め込まれた base64 を 1 度だけ展開
 */

export const BYTES_PER_POINT = 28;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Dataset {
  constructor(cfg, { baseUrl = '', inlineB64 = null, inlineBytes = null } = {}) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.hierarchy = cfg.hierarchy;
    this.url = cfg.url ? baseUrl + cfg.url : null;
    this.pointCount = cfg.pointCount;
    // 取り込み時はワーカから ArrayBuffer が転送されてくるので base64 を経由しない
    this.inline = inlineBytes
      ? (inlineBytes instanceof Uint8Array ? inlineBytes : new Uint8Array(inlineBytes))
      : (inlineB64 ? b64ToBytes(inlineB64) : null);
    this._whole = null;
    this._rangeSupported = true;

    this.byName = new Map();
    for (const nd of this.hierarchy.nodes) {
      this.byName.set(nd.name, { ...nd, loaded: false, loading: false, buffer: null, children: [] });
    }
    for (const nd of this.byName.values()) {
      if (nd.name === 'r') continue;
      const parent = this.byName.get(nd.name.slice(0, -1));
      if (parent) parent.children.push(nd);
    }
    this.root = this.byName.get('r');
  }

  get origin() { return this.hierarchy.origin; }
  get scale() { return this.hierarchy.scale[0]; }

  async fetchNode(node) {
    if (this.inline) {
      return this.inline.buffer.slice(
        this.inline.byteOffset + node.byteOffset,
        this.inline.byteOffset + node.byteOffset + node.byteSize
      );
    }
    if (this._whole) {
      return this._whole.slice(node.byteOffset, node.byteOffset + node.byteSize);
    }
    if (this._rangeSupported) {
      const res = await fetch(this.url, {
        headers: { Range: `bytes=${node.byteOffset}-${node.byteOffset + node.byteSize - 1}` },
      });
      if (res.status === 206) return await res.arrayBuffer();
      if (res.status === 200) {
        // Range 非対応サーバ: 全体を 1 度だけ取得して以後は切り出す
        this._rangeSupported = false;
        this._whole = await res.arrayBuffer();
        return this._whole.slice(node.byteOffset, node.byteOffset + node.byteSize);
      }
      throw new Error(`データの取得に失敗しました (HTTP ${res.status})`);
    }
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`データの取得に失敗しました (HTTP ${res.status})`);
    this._whole = await res.arrayBuffer();
    return this._whole.slice(node.byteOffset, node.byteOffset + node.byteSize);
  }

  /** 生バイト列 → 描画用の型付き配列（座標はローカル原点基準の m） */
  decode(buffer, node) {
    const n = node.pointCount;
    const dv = new DataView(buffer);
    const s = this.scale;
    const pos = new Float32Array(n * 3);
    const col = new Uint8Array(n * 3);
    const dev = new Float32Array(n);
    const devAlt = new Float32Array(n);
    const cls = new Float32Array(n);
    const inten = new Float32Array(n);
    const valid = new Float32Array(n);
    const validAlt = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const p = i * BYTES_PER_POINT;
      pos[i * 3] = dv.getInt32(p, true) * s;
      pos[i * 3 + 1] = dv.getInt32(p + 4, true) * s;
      pos[i * 3 + 2] = dv.getInt32(p + 8, true) * s;
      col[i * 3] = dv.getUint8(p + 12);
      col[i * 3 + 1] = dv.getUint8(p + 13);
      col[i * 3 + 2] = dv.getUint8(p + 14);
      cls[i] = dv.getUint8(p + 15);
      inten[i] = dv.getUint16(p + 16, true) / 65535;
      const v = dv.getUint8(p + 18);
      valid[i] = v & 1;
      dev[i] = v & 1 ? dv.getFloat32(p + 20, true) : 0;
      validAlt[i] = (v & 2) ? 1 : 0;
      devAlt[i] = (v & 2) ? dv.getFloat32(p + 24, true) : 0;
    }
    return { pos, col, dev, devAlt, cls, inten, valid, validAlt, count: n };
  }
}

/** 設計 TIN のバイナリを読む（"TGND" 形式） */
export function decodeDesign(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x54474e44) throw new Error('設計データの形式が違います');
  const nv = dv.getUint32(8, true), nt = dv.getUint32(12, true);
  const pos = new Float32Array(nv * 3);
  let p = 16;
  for (let i = 0; i < nv * 3; i++, p += 4) pos[i] = dv.getFloat32(p, true);
  const idx = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++, p += 4) idx[i] = dv.getUint32(p, true);
  return { pos, idx, vertexCount: nv, triangleCount: nt };
}

export async function loadDesign(cfg, { baseUrl = '', inlineB64 = null, inlineBytes = null } = {}) {
  if (inlineBytes) {
    const u8 = inlineBytes instanceof Uint8Array ? inlineBytes : new Uint8Array(inlineBytes);
    return decodeDesign(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  }
  if (inlineB64) return decodeDesign(b64ToBytes(inlineB64).buffer);
  const res = await fetch(baseUrl + cfg.url);
  if (!res.ok) throw new Error(`設計データの取得に失敗しました (HTTP ${res.status})`);
  return decodeDesign(await res.arrayBuffer());
}
