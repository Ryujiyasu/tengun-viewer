/**
 * 起動時の動作確認ダイアログ。
 *
 * 発注者が実際に開くのはこのビューアそのものなので、動作環境の確認も
 * ここで出す。別ページに置いても開いてもらえない。
 * 庁内 PC で 1 回開けば、WebGL2 の可否・描画装置・ソフトウェア描画かどうかが
 * その場で確定し、結果をコピーして送れる。
 *
 * 問題なければ 1 度見せて以後は出さない（localStorage）。
 * 問題があるときは毎回出す。
 */
import { h } from './ui.js';
import { BRAND } from './generated/brand.js';

const SEEN_KEY = 'tengun.envcheck.seen.v1';

export function buildEnvReport(gl) {
  const rows = [];
  let level, title, detail, howto = [];

  if (gl.ok && !gl.software) {
    level = 'ok';
    title = 'この PC で問題なく動きます';
    detail = 'WebGL2 が有効で、GPU で描画されています。';
  } else if (gl.ok && gl.software) {
    level = 'warn';
    title = '表示はできますが、動作が遅くなります';
    detail = 'WebGL2 は使えますが、GPU ではなくソフトウェアで描画しています。'
      + '回転・拡大の操作が重くなります。';
    howto = [
      'Edge: 設定 →「システムとパフォーマンス」→「使用可能な場合はグラフィック アクセラレータを使用する」を有効にして再起動',
      'Chrome: 設定 →「システム」→「ハードウェア アクセラレーションが使用可能な場合は使用する」を有効にして再起動',
      '設定が変えられない場合は、庁内のポリシーや仮想環境の制約が考えられます',
    ];
  } else {
    level = 'ng';
    title = gl.reason ?? '3D 表示は使えません';
    detail = `${gl.detail ?? ''} 平面図・断面図・較差カラーマップ・帳票は 2D 表示でご覧いただけます。`;
    howto = gl.howto ?? [];
  }

  if (gl.ok) {
    rows.push(['WebGL2', '利用可']);
    rows.push(['描画装置', gl.renderer]);
    rows.push(['提供元', gl.vendor]);
    rows.push(['ソフトウェア描画', gl.software ? 'はい' : 'いいえ']);
    rows.push(['最大テクスチャ', `${gl.maxTextureSize} px`]);
  } else {
    rows.push(['WebGL2', '利用不可']);
    rows.push(['WebGL1', gl.hasWebGL1 ? '利用可' : '利用不可']);
  }
  rows.push(['ブラウザ', navigator.userAgent]);
  rows.push(['画面', `${window.innerWidth} × ${window.innerHeight}（DPR ${window.devicePixelRatio || 1}）`]);
  if (navigator.deviceMemory) rows.push(['メモリ', `${navigator.deviceMemory} GB 以上`]);
  if (navigator.hardwareConcurrency) rows.push(['CPU', `${navigator.hardwareConcurrency} 論理コア`]);
  rows.push(['確認日時', new Date().toLocaleString('ja-JP')]);

  return { level, title, detail, howto, rows };
}

/** @returns {{el:HTMLElement, open:Function, close:Function}} */
export function createEnvDialog(gl, { onClose } = {}) {
  const r = buildEnvReport(gl);

  const kv = h('dl', { class: 'env-kv' },
    r.rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]));

  const copyBtn = h('button', { class: 'btn', text: 'この結果をコピー', onclick: async () => {
    const text = `${r.title}\n${r.detail}\n\n` + r.rows.map(([k, v]) => `${k}: ${v}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'コピーしました';
      setTimeout(() => { copyBtn.textContent = 'この結果をコピー'; }, 2000);
    } catch {
      window.prompt('この内容をコピーしてください', text);
    }
  } });

  const el = h('div', { class: 'modal' }, [
    h('div', { class: `modal-box env-${r.level}` }, [
      h('div', { class: 'env-head' }, [
        h('span', { class: `env-mark ${r.level}`, text: r.level === 'ok' ? '○' : r.level === 'warn' ? '△' : '×' }),
        h('div', {}, [
          h('h2', { text: r.title }),
          h('p', { class: 'env-detail', text: r.detail }),
        ]),
      ]),
      ...(r.howto.length ? [h('ul', { class: 'env-howto' }, r.howto.map((s) => h('li', { text: s })))] : []),
      h('details', { class: 'env-more' }, [
        h('summary', { text: '環境の詳細' }),
        kv,
      ]),
      h('div', { class: 'modal-actions' }, [
        h('button', { class: 'btn primary', text: r.level === 'ok' ? '閉じて表示する' : '閉じる', onclick: () => close() }),
        copyBtn,
      ]),
      h('p', { class: 'modal-note', text:
        `この確認は「診断情報」からいつでも開けます。　提供 ${BRAND.companyName}` }),
    ]),
  ]);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });

  function open() { el.classList.add('show'); }
  function close() {
    el.classList.remove('show');
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* 無効でも動く */ }
    onClose?.();
  }
  return { el, open, close, level: r.level, report: r };
}

/** 問題がないときは 2 回目以降は出さない */
export function shouldShowOnStartup(level) {
  if (level !== 'ok') return true;
  try { return localStorage.getItem(SEEN_KEY) !== '1'; } catch { return true; }
}
