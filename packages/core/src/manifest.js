/**
 * データの来歴（manifest.json）。
 *
 * いまは署名しないが、将来 C2PA 的な真正性証明に繋げられる構造にしておく。
 * ・claim / assertions の入れ子を C2PA の用語に合わせる
 * ・各ファイルの SHA-256 を持つ（ハッシュ関数は環境依存なので注入する）
 * ・signature は null。後から付けても既存フィールドを壊さない。
 */

export const MANIFEST_VERSION = 'tengun-manifest/1';

export function buildManifest({ info, inputs, outputs, processing, generator }) {
  return {
    format: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    generator,
    claim: {
      title: info.projectName ?? '',
      projectNumber: info.projectNumber ?? '',
      owner: info.owner ?? '',
      contractor: info.contractor ?? '',
      period: { start: info.startDate ?? null, end: info.endDate ?? null },
      crs: { epsg: info.epsg ?? null, label: info.crsLabel ?? null, axisOrder: info.axisOrder ?? null },
    },
    assertions: {
      'tengun.acquisition': inputs.map((i) => ({
        role: i.role,
        file: i.file,
        bytes: i.bytes,
        sha256: i.sha256,
        pointCount: i.pointCount ?? null,
        capturedAt: i.capturedAt ?? null,
        equipment: i.equipment ?? null,
        software: i.software ?? null,
      })),
      'tengun.processing': processing,
      'tengun.outputs': outputs.map((o) => ({ file: o.file, bytes: o.bytes, sha256: o.sha256, role: o.role })),
    },
    signature: null, // 未署名。付与する場合は assertions 全体を正規化して署名する。
  };
}
