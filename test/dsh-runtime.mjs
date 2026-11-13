import { spawn } from 'node:child_process';
import { mkdtemp,readFile,writeFile,mkdir,access } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function command(file,args,env){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
    child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(Error(`${file} ${args.slice(0,3).join(' ')} failed (${code}): ${output.slice(-4000)}`)));
  });
}
export async function createRuntime(){
  const cli=resolve(process.env.DSH_CLI||'.dsh-test/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');await access(cli);
  const runtimeVersion=JSON.parse(await readFile(resolve(cli,'../../package.json'),'utf8')).version;
  const pluginVersion=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
  const home=await mkdtemp(join(tmpdir(),'dsh-journal-'));
  const env={...process.env,DSH_HOME:home,DSH_TEST_ANCHOR:cli};
  const npm=process.platform==='win32'?'npm.cmd':'npm';
  // npm.cmd requires a shell on Windows. Use npm's JS entry when supplied by npm scripts.
  const pack=process.env.npm_execpath?await command(process.execPath,[process.env.npm_execpath,'pack','--ignore-scripts','--json'],env):await command(npm,['pack','--ignore-scripts','--json'],env);
  const json=JSON.parse(pack.slice(pack.indexOf('['),pack.lastIndexOf(']')+1));
  await command(process.execPath,[cli,'plugin','--profile','web','add',join(root,json[0].filename)],env);
  const patch=join(home,'test.patch.yml');
  await writeFile(patch,`- insert:\n    - id: journal-integration-fixture\n      name: ${JSON.stringify(join(root,'test','dsh-fixture.mjs'))}\n`);
  let child,log='',base='',cookie='';
  async function start(){
    log='';child=spawn(process.execPath,[cli,'--profile','web','--patch',patch,'--no-open','--port','0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
    for(let i=0;i<600;i++){
      if(child.exitCode!==null)throw Error(`DSH boot failed: ${log.replace(/token=\S+/g,'token=[redacted]')}`);
      const url=log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
      if(url){base=new URL(url).origin;const res=await fetch(url,{redirect:'manual'});cookie=res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');break;}
      await delay(100);
    }
    if(!base)throw Error(`DSH did not become ready: ${log.replace(/token=\S+/g,'token=[redacted]')}`);
    for(let i=0;i<600;i++){try{const state=await api('status',{},'journal-test');if(state.ready)return;}catch{}await delay(100);}
    throw Error(`Fixture unavailable: ${log.replace(/token=\S+/g,'token=[redacted]')}`);
  }
  async function stop(){
    if(!child||child.exitCode!==null)return;
    const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');
    await Promise.race([exited,delay(6000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}
  }
  async function api(action,params={},endpoint='dsh-collab-journal'){
    const res=await fetch(`${base}/api/${endpoint}`,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({action,...params})});
    let value;try{value=await res.json();}catch{throw Error(`HTTP ${res.status}`);}if(!res.ok||value.ok===false)throw Error(value.error||JSON.stringify(value));return endpoint==='journal-test'?value:value.value;
  }
  async function settled(id){for(let i=0;i<400;i++){const d=await api('detail',{id});if(d.run?.status!=='running')return d;await delay(100);}throw Error('parse timeout');}
  return {home,runtimeVersion,pluginVersion,start,stop,api,settled,get base(){return base;},get cookie(){return cookie;},get log(){return log.replace(/token=\S+/g,'token=[redacted]');}};
}
