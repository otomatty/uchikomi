import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
await viteBuild();
await copyFile('THIRD_PARTY_NOTICES.txt','dist/THIRD_PARTY_NOTICES.txt');
await esbuild({entryPoints:['src/capture/background.ts'],bundle:true,format:'esm',platform:'browser',target:'chrome116',outfile:'dist/background.js',minify:true});
await esbuild({entryPoints:['src/capture/content.ts'],bundle:true,format:'iife',platform:'browser',target:'chrome116',outfile:'dist/content.js',minify:true});
await mkdir('dist/vendor/core',{recursive:true});
await mkdir('dist/vendor/lang',{recursive:true});
await copyFile('node_modules/tesseract.js/dist/worker.min.js','dist/vendor/worker.min.js');
for(const name of await readdir('node_modules/tesseract.js-core')) if(name.endsWith('.wasm')||name.endsWith('.wasm.js')) await copyFile(`node_modules/tesseract.js-core/${name}`,`dist/vendor/core/${name}`);
for(const lang of ['eng','jpn']) {
  // Keep the more accurate Japanese model; the compact one misread kana fixtures.
  const flavor = lang === 'jpn' ? '4.0.0' : '4.0.0_best_int';
  await copyFile(`node_modules/@tesseract.js-data/${lang}/${flavor}/${lang}.traineddata.gz`,`dist/vendor/lang/${lang}.traineddata.gz`);
}
// Bundled, self-contained UI preview. It has no recording permissions and never fakes captures.
const preview=await esbuild({entryPoints:['src/app/main.tsx'],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,outfile:'preview.js',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
const js=preview.outputFiles.find(f=>f.path.endsWith('.js')).text;
const css=preview.outputFiles.find(f=>f.path.endsWith('.css')).text;
await writeFile('preview.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UCHIKOMI — UIプレビュー</title><style>${css}</style><body><div id="root"></div><script>${js.replaceAll('</script','<\\/script')}</script></body></html>`);
console.log('Extension built: dist/  ·  Standalone UI: preview.html');
