/**
 * データ取り込みの画面。
 *
 * CLI を通さず、LAS/LAZ と設計 LandXML をこの画面に放り込めば、その場で
 * 較差計算・規格値判定まで行う。受注者が納品前に自分で確認するための入口。
 *
 * 判定・統計は全点で計算する（間引かない）。表示用に間引くのは octree だけ。
 */
import { h, section } from '../ui.js';
import { classifyFile } from './read-file.js';
import ImportWorker from './worker.js?worker&inline';

const MAX_SAFE_BYTES = 800 * 1024 * 1024;

export function createImportPanel({ onLoaded, workTypes }) {
  const files = { points: null, pre: null, design: null, info: null };

  const slots = {
    points: slot('出来形点群', 'LAS / LAZ', true),
    design: slot('設計データ', 'LandXML (.xml)', true),
    info: slot('工事情報', 'JSON（任意）', false),
    pre: slot('起工測量点群', 'LAS / LAZ（任意）', false),
  };

  const status = h('div', { class: 'import-status' });
  const bar = h('div', { class: 'import-bar' }, [h('div', { class: 'import-bar-fill' })]);
  const barWrap = h('div', { class: 'import-bar-wrap' }, [bar, h('div', { class: 'import-phase' })]);
  barWrap.style.display = 'none';

  const runBtn = h('button', { class: 'btn primary', text: '読み込んで較差を計算', disabled: 'true', onclick: run });

  const drop = h('div', { class: 'dropzone' }, [
    h('div', { class: 'dropzone-title', text: 'ここにファイルをドラッグ' }),
    h('div', { class: 'dropzone-sub', text: 'LAS / LAZ と 設計 LandXML（.xml）。工事情報 JSON があれば一緒に。' }),
    h('label', { class: 'btn' }, [
      'ファイルを選ぶ',
      h('input', {
        type: 'file', multiple: 'true', accept: '.las,.laz,.xml,.json', style: 'display:none',
        onchange: (e) => { accept([...e.target.files]); e.target.value = ''; },
      }),
    ]),
  ]);

  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', (e) => accept([...(e.dataTransfer?.files ?? [])]));

  const axisSelect = h('select', { class: 'select' }, [
    h('option', { value: 'EN', text: 'X が東 / Y が北（一般的な LAS）' }),
    h('option', { value: 'NE', text: 'X が北 / Y が東（測量座標をそのまま）' }),
  ]);
  const workSelect = h('select', { class: 'select' },
    (workTypes ?? []).map((w) => h('option', { value: w.id, text: w.name })));
  const groundOnly = h('input', { type: 'checkbox', checked: 'true' });

  const el = section('データを開く', [
    drop,
    h('div', { class: 'slot-list' }, Object.values(slots).map((s) => s.el)),
    h('div', { class: 'field' }, [h('label', { text: '軸の並び' }), axisSelect]),
    ...(workTypes?.length ? [h('div', { class: 'field' }, [h('label', { text: '工種' }), workSelect])] : []),
    h('label', { class: 'check' }, [groundOnly, h('span', { text: '地表面(分類 2,11)のみ判定に使う' })]),
    runBtn,
    barWrap,
    status,
    h('p', { class: 'muted', text:
      '判定・統計は間引かず全点で計算します。表示用の間引きは数字に影響しません。'
      + ' 読み込んだデータはこの PC のブラウザ内だけで処理され、どこにも送信されません。' }),
  ], { open: true });

  function slot(label, hint, required) {
    const name = h('span', { class: 'slot-file', text: '未選択' });
    const wrap = h('div', { class: `slot ${required ? 'required' : ''}` }, [
      h('span', { class: 'slot-label', text: label }),
      name,
      h('span', { class: 'slot-hint', text: hint }),
    ]);
    return { el: wrap, name, wrap };
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

  function refresh() {
    const ready = files.points && files.design;
    if (ready) runBtn.removeAttribute('disabled'); else runBtn.setAttribute('disabled', 'true');
    const big = [files.points, files.pre].filter(Boolean).reduce((s, f) => s + f.size, 0);
    if (big > MAX_SAFE_BYTES) {
      note(`点群が ${mb(big)} あります。ブラウザのメモリ上限に当たる可能性があります。`
        + 'うまくいかない場合は CLI（ptv build）で変換してください。', 'warn');
    }
  }

  function note(text, kind = '') {
    status.className = `import-status ${kind}`;
    status.textContent = text;
  }

  async function run() {
    runBtn.setAttribute('disabled', 'true');
    barWrap.style.display = 'block';
    note('');
    const t0 = performance.now();
    try {
      const [pointsBuffer, preBuffer, designText, infoText] = await Promise.all([
        files.points.arrayBuffer(),
        files.pre ? files.pre.arrayBuffer() : null,
        files.design.text(),
        files.info ? files.info.text() : null,
      ]);

      let lastPhase = '';
      const worker = new ImportWorker();
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'progress') { setProgress(m.phase, m.done, m.total); lastPhase = m.phase; }
          else if (m.type === 'result') resolve(m.payload);
          else if (m.type === 'error') reject(new Error(m.message));
        };
        worker.onerror = (e) => reject(new Error(`${e.message || '取り込み処理が異常終了しました'}（${lastPhase}）`));
        worker.postMessage(
          { type: 'import', payload: { pointsBuffer, preBuffer, designText, infoText,
            options: {
              axisOrder: axisSelect.value,
              workType: workSelect.value || undefined,
              groundOnly: groundOnly.checked,
              fileName: files.points.name,
            } } },
          [pointsBuffer, preBuffer].filter(Boolean)
        );
      });
      worker.terminate();

      setProgress('完了', 1, 1);
      const s = result.config.importSummary;
      note(`${s.pointCount.toLocaleString()} 点を ${(s.totalMs / 1000).toFixed(1)} 秒で処理しました`
        + `（読み込み ${(s.timings.readPoints / 1000).toFixed(1)}s / 較差 ${(s.timings.deviation / 1000).toFixed(1)}s`
        + ` / 表示用 ${(s.timings.octree / 1000).toFixed(1)}s）`, 'ok');
      onLoaded(result);
    } catch (err) {
      console.error(err);
      note(`読み込めませんでした: ${err.message}`, 'error');
      barWrap.style.display = 'none';
      runBtn.removeAttribute('disabled');
    }
  }

  function setProgress(phase, done, total) {
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    bar.querySelector('.import-bar-fill').style.width = `${pct.toFixed(1)}%`;
    barWrap.querySelector('.import-phase').textContent =
      total > 1 ? `${phase}  ${Math.floor(pct)}%` : phase;
  }

  return { el, accept };
}

const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);
