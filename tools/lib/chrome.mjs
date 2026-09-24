/**
 * 検証・収録に使うブラウザを探す。
 *
 * puppeteer 同梱の Chromium は落とさず、PC に入っている Chrome / Edge を使う。
 * 対象ブラウザ（Edge・Chrome の現行版）の実物で確かめたいのと、
 * 400MB 近い追加ダウンロードを避けるため。
 *
 * CHROME_PATH を指定すればそれを最優先する。
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANDIDATES = [
  process.env.CHROME_PATH,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function findChrome({ required = true } = {}) {
  for (const p of CANDIDATES) if (existsSync(p)) return p;
  // PATH 上も見る
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (p && existsSync(p)) return p;
    } catch { /* 見つからないだけ */ }
  }
  if (!required) return null;
  throw new Error(
    '検証用のブラウザが見つかりません。Chrome か Edge を入れるか、CHROME_PATH で場所を指定してください。\n'
    + `  探した場所: ${CANDIDATES.slice(1).join(', ')}`
  );
}

/** Linux の CI やコンテナで必要になる起動オプションを足す */
export function chromeArgs(extra = []) {
  const base = ['--no-sandbox', '--disable-dev-shm-usage'];
  return [...base, ...extra];
}
