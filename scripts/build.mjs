import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('lib', {recursive:true});
await build({entryPoints:['src/index.mjs'], bundle:true, platform:'node', format:'esm', target:'node24', packages:'external', outfile:'lib/index.js'});
await build({entryPoints:['src/client.jsx'], bundle:true, platform:'browser', format:'cjs', target:'es2022', outfile:'lib/client.js', external:['react','react/jsx-runtime'], loader:{'.css':'text'},
  banner:{js:'window.__ModuleLoader__.load({id:"dsh-collab-journal",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},
  footer:{js:'return module.exports;}});'}, define:{'process.env.NODE_ENV':'"production"'}});
