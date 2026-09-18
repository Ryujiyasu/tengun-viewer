import { defineConfig } from 'vite';

// 外部 CDN への依存を持たないこと。閉域網では読めない。
// 出力はハッシュなしの固定名にして、CLI が素直に取り込めるようにする。
export default defineConfig({
  // ワーカは ES モジュール形式。メイン側の iife とは別扱いにする必要がある。
  // （iife はコード分割を伴うビルドでは使えない）
  worker: {
    format: 'es',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000, // 画像等はすべてインライン化（外部ファイルを作らない）
    rollupOptions: {
      input: 'src/main.js',
      output: {
        format: 'iife',
        name: 'TengunBundle',
        entryFileNames: 'viewer.js',
        assetFileNames: 'viewer[extname]',
        inlineDynamicImports: true,
      },
    },
  },
});
