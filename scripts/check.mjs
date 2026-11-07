import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.mjs';
let failed=false;
for(const directory of ['src','scripts','test','public'])for(const file of fs.readdirSync(path.join(ROOT,directory))){
  if(!/\.(mjs|js)$/.test(file))continue;
  const r=spawnSync(process.execPath,['--check',path.join(ROOT,directory,file)],{encoding:'utf8'});
  if(r.status!==0){failed=true;console.error(r.stderr)}
}
if(failed)process.exitCode=1;else console.log('Syntax checks passed.');
