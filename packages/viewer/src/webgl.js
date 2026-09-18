/**
 * WebGL2 の利用可否判定。
 * 使えないときに黒い画面のまま放置しない。原因を日本語で出し、2D モードへ落とす。
 */
export function probeWebGL2() {
  const canvas = document.createElement('canvas');
  let gl = null;
  let creationError = null;

  const onError = (e) => { creationError = e.statusMessage || String(e.statusMessage ?? ''); };
  canvas.addEventListener('webglcontextcreationerror', onError, false);
  try {
    gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    creationError = e.message;
  }
  canvas.removeEventListener('webglcontextcreationerror', onError);

  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const info = {
      ok: true,
      renderer: String(renderer),
      vendor: String(vendor),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxPointSize: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] ?? null,
      software: /swiftshader|llvmpipe|software|basic render/i.test(String(renderer)),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  }

  // 使えない理由を切り分ける
  const gl1 = (() => { try { return canvas.getContext('webgl') || canvas.getContext('experimental-webgl'); } catch { return null; } })();
  let reason, detail, howto;
  if (gl1) {
    reason = 'このブラウザ／PC では WebGL2 が使えません（WebGL1 のみ利用可）';
    detail = 'グラフィックドライバまたはブラウザのバージョンが WebGL2 に対応していません。';
    howto = ['ブラウザ（Microsoft Edge / Google Chrome）を最新版に更新してください。',
             'それでも直らない場合はグラフィックドライバの更新が必要です。'];
  } else if (typeof WebGL2RenderingContext === 'undefined') {
    reason = 'このブラウザは WebGL2 に対応していません';
    detail = 'Internet Explorer や互換モードでは動作しません。';
    howto = ['Microsoft Edge または Google Chrome の現行版で開き直してください。',
             'Edge で「Internet Explorer モード」になっていないか確認してください。'];
  } else {
    reason = 'WebGL2 が無効化されています';
    detail = creationError ? `ブラウザからの応答: ${creationError}` : 'ハードウェアアクセラレーションが切られている可能性があります。';
    howto = ['Edge: 設定 →「システムとパフォーマンス」→「使用可能な場合はグラフィック アクセラレータを使用する」を有効にして再起動。',
             'Chrome: 設定 →「システム」→「ハードウェア アクセラレーションが使用可能な場合は使用する」を有効にして再起動。',
             '庁内ポリシーで無効化されている場合は情報部門に確認してください。'];
  }
  return { ok: false, reason, detail, howto, hasWebGL1: !!gl1 };
}
