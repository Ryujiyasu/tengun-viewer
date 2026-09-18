/**
 * データ取り込み画面。
 *
 * CLI を通さず、LAS/LAZ と設計 LandXML をここに放り込めば、その場で
 * 較差計算・規格値判定まで行う。受注者が納品前に自分で確認するための入口。
 *
 * 側パネルの中に畳んで置くと見つけてもらえないので、独立した画面にする。
 *
 * 判定・統計は全点で計算する（間引かない）。表示用に間引くのは octree だけ。
 */
import { h } from '../ui.js';
import { BRAND } from '../generated/brand.js';
import { classifyFile } from './read-file.js';
import ImportWorker from './worker.js?worker&inline';

const MAX_SAFE_BYTES = 800 * 1024 * 1024;
const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);

export function createImportScreen({ onLoaded, workTypes = [] }) {
  const files = { points: null, pre: null, design: null, info: null };

  const slots = {
    points: makeSlot('出来形点群', 'LAS / LAZ', true, '測量した点群。これが評価の対象になります。'),
    design: makeSlot('設計データ', 'LandXML (.xml)', true, '3次元設計データ。TIN サーフェスを含むもの。'),
    info: makeSlot('工事情報', 'JSON', false, '工事名・座標系など。無くても較差は計算できます。'),
    pre: makeSlot('起工測量点群', 'LAS / LAZ', false, '施工前の地山。土量の目安を出すのに使います。'),
  };

  const status = h('div', { class: 'imp-status' });
  const fill = h('div', { class: 'imp-bar-fill' });
  const phase = h('div', { class: 'imp-phase' });
  const bar = h('div', { class: 'imp-bar-wrap' }, [h('div', { class: 'imp-bar' }, [fill]), phase]);
  bar.style.display = 'none';

  const runBtn = h('button', { class: 'btn primary big', disabled: 'true', text: '読み込んで較差を計算', onclick: run });
  const clearBtn = h('button', { class: 'btn', text: 'すべて取り消す', onclick: () => { for (const k of Object.keys(files)) clearFile(k); refresh(); } });

  const fileInput = h('input', {
    type: 'file', multiple: 'true', accept: '.las,.laz,.xml,.json', style: 'display:none',
    onchange: (e) => { accept([...e.target.files]); e.target.value = ''; },
  });

  const drop = h('div', { class: 'imp-drop' }, [
    h('div', { class: 'imp-drop-icon', html:
      '<svg viewBox="0 0 64 44" width="72" height="50" aria-hidden="true">'
      + '<rect x="1" y="9" width="62" height="34" rx="4" fill="none" stroke="#aebac1" stroke-width="2"/>'
      + '<path d="M32 34V13M32 13l-8 8M32 13l8 8" fill="none" stroke="#008746" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M1 30h18l4 6h18l4-6h18" fill="none" stroke="#aebac1" stroke-width="2"/></svg>' }),
    h('div', { class: 'imp-drop-title', text: 'ここにファイルをドラッグしてください' }),
    h('div', { class: 'imp-drop-sub', text: '点群（LAS / LAZ）と 設計データ（LandXML .xml）。工事情報 JSON があれば一緒に。' }),
    h('label', { class: 'btn' }, ['ファイルを選ぶ', fileInput]),
  ]);

  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => accept([...(e.dataTransfer?.files ?? [])]));

  const axisSelect = h('select', { class: 'select' }, [
    h('option', { value: 'EN', text: 'X が東 / Y が北（一般的な LAS）' }),
    h('option', { value: 'NE', text: 'X が北 / Y が東（測量座標をそのまま）' }),
  ]);
  const workSelect = h('select', { class: 'select' }, workTypes.map((w) => h('option', { value: w.id, text: w.name })));
  const groundOnly = h('input', { type: 'checkbox', checked: 'true' });

  const options = h('details', { class: 'imp-options' }, [
    h('summary', { text: '詳しい設定' }),
    h('div', { class: 'imp-options-body' }, [
      h('div', { class: 'field' }, [h('label', { text: '軸の並び' }), axisSelect]),
      ...(workTypes.length ? [h('div', { class: 'field' }, [h('label', { text: '工種' }), workSelect])] : []),
      h('label', { class: 'check' }, [groundOnly, h('span', { text: '地表面（分類 2, 11）のみを判定に使う' })]),
      h('p', { class: 'muted', text:
        '軸の並びは、点群の X が東か北かの指定です。工事情報 JSON にある場合はそちらが優先されます。'
        + ' 点群と設計面が平面上で重ならない場合は警告を出します。' }),
    ]),
  ]);

  const closeBtn = h('button', { class: 'imp-close', text: '× 閉じる', onclick: () => close() });

  const el = h('div', { class: 'imp-screen' }, [
    h('div', { class: 'imp-inner' }, [
      h('div', { class: 'imp-head' }, [
        h('div', {}, [
          h('h2', { text: 'データを開く' }),
          h('p', { class: 'imp-lead', text:
            '手元の点群と設計データを読み込んで、その場で較差と規格値判定を出します。'
            + ' 変換用のソフトは要りません。' }),
        ]),
        closeBtn,
      ]),
      drop,
      h('div', { class: 'imp-slots' }, Object.values(slots).map((s) => s.el)),
      options,
      h('div', { class: 'imp-actions' }, [runBtn, clearBtn]),
      bar,
      status,
      h('p', { class: 'imp-note', text:
        '判定・統計は間引かずに全点で計算します。表示用の間引きは数字に影響しません。'
        + ` 読み込んだデータはこの PC のブラウザ内だけで処理され、どこにも送信されません。（${BRAND.companyName}）` }),
    ]),
  ]);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });

  function makeSlot(label, hint, required, desc) {
    const name = h('span', { class: 'imp-slot-file', text: '未選択' });
    const remove = h('button', { class: 'imp-slot-x', text: '×', title: '取り消す' });
    const wrap = h('div', { class: `imp-slot ${required ? 'required' : ''}` }, [
      h('div', { class: 'imp-slot-head' }, [
        h('span', { class: 'imp-slot-label', text: label }),
        h('span', { class: `imp-slot-tag ${required ? 'req' : ''}`, text: required ? '必須' : '任意' }),
        remove,
      ]),
      name,
      h('span', { class: 'imp-slot-hint', text: `${hint}　${desc}` }),
    ]);
    return { el: wrap, name, wrap, remove };
  }
  for (const [k, s] of Object.entries(slots)) {
    s.remove.addEventListener('click', () => { clearFile(k); refresh(); });
  }

  function accept(list) {
    for (const f of list) {
      const kind = classifyFile(f);
      if (kind === 'points') {
        if (!files.points) setFile('points', f);
        else if (!files.pre) setFile('pre', f);
        else setFile('points', f);
      } else if (kind === 'design') setFile('design', f);
      else if (kind === 'info') setFile('info', f);
      else note(`対応していないファイルです: ${f.name}`, 'warn');
    }
    refresh();
  }

  function setFile(key, f) {
    files[key] = f;
    slots[key].name.textContent = `${f.name}（${mb(f.size)}）`;
    slots[key].wrap.classList.add('filled');
  }
  function clearFile(key) {
    files[key] = null;
    slots[key].name.textContent = '未選択';
    slots[key].wrap.classList.remove('filled');
  }

  function refresh() {
    const ready = files.points && files.design;
    if (ready) runBtn.removeAttribute('disabled'); else runBtn.setAttribute('disabled', 'true');
    if (!ready) {
      const missing = [!files.points && '点群', !files.design && '設計データ'].filter(Boolean);
      note(`${missing.join('と')}を選んでください`, '');
    } else {
      note('準備ができました。「読み込んで較差を計算」を押してください。', 'ok');
    }
    const big = [files.points, files.pre].filter(Boolean).reduce((s, f) => s + f.size, 0);
    if (big > MAX_SAFE_BYTES) {
      note(`点群が ${mb(big)} あります。ブラウザのメモリ上限に当たる可能性があります。`
        + 'うまくいかない場合は CLI（ptv build）で変換してください。', 'warn');
    }
  }

  function note(text, kind = '') {
    status.className = `imp-status ${kind}`;
    status.textContent = text;
  }

  function setProgress(p, done, total) {
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    fill.style.width = `${pct.toFixed(1)}%`;
    phase.textContent = total > 1 ? `${p}　${Math.floor(pct)}%` : p;
  }

  async function run() {
    runBtn.setAttribute('disabled', 'true');
    clearBtn.setAttribute('disabled', 'true');
    bar.style.display = 'block';
    note('読み込んでいます…', '');
    let lastPhase = '';
    try {
      const [pointsBuffer, preBuffer, designText, infoText] = await Promise.all([
        files.points.arrayBuffer(),
        files.pre ? files.pre.arrayBuffer() : null,
        files.design.text(),
        files.info ? files.info.text() : null,
      ]);
      const worker = new ImportWorker();
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'progress') { setProgress(m.phase, m.done, m.total); lastPhase = m.phase; }
          else if (m.type === 'result') resolve(m.payload);
          else if (m.type === 'error') reject(new Error(m.message));
        };
        worker.onerror = (e) => reject(new Error(`${e.message || '取り込み処理が異常終了しました'}（${lastPhase}）`));
        worker.postMessage({ type: 'import', payload: {
          pointsBuffer, preBuffer, designText, infoText,
          options: {
            axisOrder: axisSelect.value,
            workType: workSelect.value || undefined,
            groundOnly: groundOnly.checked,
            fileName: files.points.name,
          },
        } }, [pointsBuffer, preBuffer].filter(Boolean));
      });
      worker.terminate();
      setProgress('完了', 1, 1);
      onLoaded(result);
    } catch (err) {
      console.error(err);
      note(`読み込めませんでした: ${err.message}`, 'error');
      bar.style.display = 'none';
      runBtn.removeAttribute('disabled');
      clearBtn.removeAttribute('disabled');
    }
  }

  function open() { el.classList.add('show'); refresh(); }
  function close() { el.classList.remove('show'); }

  return { el, open, close, accept, isOpen: () => el.classList.contains('show') };
}
