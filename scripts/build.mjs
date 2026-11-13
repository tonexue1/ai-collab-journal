import { build } from 'esbuild';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash=createHash('sha256');
for(const path of ['package.json','scripts/build.mjs',...(await readdir('src')).sort().map(name=>`src/${name}`)]){
  hash.update(path).update('\0').update(await readFile(path)).update('\0');
}
const {version}=JSON.parse(await readFile('package.json','utf8'));
const define={'__JOURNAL_BUILD__':JSON.stringify({version,id:hash.digest('hex').slice(0,12)})};
await mkdir('lib', {recursive:true});
await build({entryPoints:['src/index.mjs'], bundle:true, platform:'node', format:'esm', target:'node24', packages:'external', outfile:'lib/index.js',define});
await build({entryPoints:['src/client.jsx'], bundle:true, platform:'browser', format:'cjs', target:'es2022', outfile:'lib/client.js', external:['react','react/jsx-runtime'], loader:{'.css':'text'},
  banner:{js:'window.__ModuleLoader__.load({id:"dsh-collab-journal",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},
  footer:{js:'return module.exports;}});'}, define:{...define,'process.env.NODE_ENV':'"production"'}});
