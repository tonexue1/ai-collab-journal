import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { JournalError } from './service.mjs';

const execute = promisify(execFile);
const maxFileBytes = 24000;
const supported = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|lua|sh|sql|html?|css|scss|vue|svelte|md|txt|json|toml|ya?ml)$/i;

function isCodePath(path) {
  if (typeof path !== 'string' || path.length > 220 || !supported.test(path) || /[\\:\x00-\x1f<>?"*|]/.test(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part && !part.startsWith('.') && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    && !parts.some(part => /^(?:node_modules|AGENTS\.md|SKILL\.md|credentials?(?:[.-]|$)|secrets?(?:[.-]|$)|id_rsa)/i.test(part));
}

async function git(root, args, maxBuffer = 2 * 1024 * 1024) {
  try {
    const {stdout} = await execute('git', ['--no-replace-objects', '--literal-pathspecs', '-C',root,...args], {
      encoding:'buffer', timeout:15000, maxBuffer, windowsHide:true,
      env: {...Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TMP','TEMP','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),
        GIT_OPTIONAL_LOCKS:'0', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_NO_LAZY_FETCH:'1', GIT_ALLOW_PROTOCOL:''},
    });
    return stdout;
  } catch {throw new JournalError('无法在本地读取 Git 版本。请核对提交是否存在、Git 是否可用，以及项目是否超过读取上限。');}
}

export async function gitRoot(path) {
  if (!path || !isAbsolute(path)) throw new JournalError('这段会话尚未关联本地 Git 工作区；仍可收藏和回看。');
  const root=(await git(path,['rev-parse','--show-toplevel'])).toString().trim();
  if(await realpath(root)!==await realpath(path))throw new JournalError('复演只支持工作区本身为 Git 仓库根目录的项目。');
  return root;
}

export async function nearbyCommits(root, time) {
  const format = '%H%x00%ct%x00%s';
  // Start with recent history; include up to 30 older commits around the original date.
  const args=['log','--no-show-signature','-z','-n','30',`--format=${format}`];
  const batches=[await git(root,args)];
  if(Number.isFinite(time))batches.push(await git(root,[...args,`--before=@${Math.floor(time/1000)+86400}`]));
  const mapped=new Map();
  for(const batch of batches){
    const fields=batch.toString().split('\0');
    for(let i=0;i+2<fields.length;i+=3)mapped.set(fields[i],{sha:fields[i],date:Number(fields[i+1])*1000,title:fields[i+2]});
  }
  return [...mapped.values()].sort((a,b)=>b.date-a.date);
}

async function verifiedCommit(root,value){
  if(typeof value!=='string'||! /^[a-f\d]{40}$/i.test(value))throw new JournalError('请选择或填写完整的 40 位 Git 提交标识。');
  const sha=value.toLowerCase();
  if((await git(root,['cat-file','-t',sha])).toString().trim()!=='commit')throw new JournalError('选定的版本不是 Git 提交。');
  return sha;
}
async function tree(root,sha,paths){
  const listing=await git(root,['ls-tree','-r','-l','-z',sha,...(paths?['--',...paths]:[])]);
  const rows=new Map();
  for(const line of listing.toString().split('\0')){
    const split=line.indexOf('\t');
    if(split<0)continue;
    const [mode,kind,hash,size]=line.slice(0,split).trim().split(/\s+/);
    rows.set(line.slice(split+1),{mode,kind,hash,size:Number(size)});
  }
  return rows;
}
function readable(row){return row.kind==='blob' && ['100644','100755'].includes(row.mode) && row.size<=maxFileBytes;}
async function readBlob(root,row){
  if(!row)return null;
  if(!readable(row))throw new JournalError('选定文件包含链接、子模块或超过 24 KB；请另选小型 UTF-8 文本文件。');
  const data=await git(root,['cat-file','blob',row.hash],maxFileBytes+1);
  if(data.includes(0))throw new JournalError('选定文件含二进制内容。');
  try {return new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(data);}
  catch {throw new JournalError('选定文件不是 UTF-8 文本。');}
}
async function versions(root,base,reference){
  const [start,end]=await Promise.all([verifiedCommit(root,base),verifiedCommit(root,reference)]);
  if(start===end)throw new JournalError('请选择两个不同的提交。');
  try{await git(root,['merge-base','--is-ancestor',start,end]);}
  catch{throw new JournalError('开工版本须在认可交付的提交历史之前。');}
  return [start,end];
}
export async function replayPaths(root,base,reference){
  const shas=await versions(root,base,reference);
  const [first,last]=await Promise.all(shas.map(sha=>tree(root,sha)));
  return [...first.keys()].filter(path=>isCodePath(path) && readable(first.get(path))
    && (!last.has(path)||readable(last.get(path)))).sort();
}

export async function freezeFiles(root,{base,reference,paths}){
  if(!Array.isArray(paths)||!paths.length||paths.length>8||!paths.every(isCodePath)
    ||new Set(paths.map(p=>p.normalize('NFC').toLowerCase())).size!==paths.length)throw new JournalError('请选择 1–8 个互不重复的普通代码文本路径。');
  for(const path of paths)if(paths.some(other=>other.toLowerCase().startsWith(path.toLowerCase()+'/')))throw new JournalError('文件路径与目录重叠。');
  const [start,end]=await versions(root,base,reference);
  const [first,last]=await Promise.all([tree(root,start,[...paths,'AGENTS.md']),tree(root,end,paths)]);
  const sources=[],referencePaths=[];
  for(const path of paths){
    if(!first.has(path))throw new JournalError('仅支持开工提交中已存在的文件，请重新选择复演范围。');
    const [before,after]=await Promise.all([readBlob(root,first.get(path)),readBlob(root,last.get(path))]);
    sources.push({path,text:before});referencePaths.push({path,text:after});
  }
  if(sources.every((file,i)=>file.text===referencePaths[i].text))throw new JournalError('所选文件在开工和交付时内容完全相同，请选择这次交付实际改动的文件。');
  const rules=(await readBlob(root,first.get('AGENTS.md')))??'';
  if(JSON.stringify({sources,rules}).length>32000)throw new JournalError('所选文件及起始规则合计超过 32,000 字符。请缩小复演范围。');
  return {base:start,reference:end,paths:[...paths],referencePaths,sources,rules};
}

// Create only the selected regular files from verified blobs. No checkout, Git
// history, hooks, project executables or inherited agent tools enter the runner.
export async function editCopy(snapshot, rules, generate, signal) {
  const dir=await mkdtemp(join(tmpdir(),'dsh-journal-replay-'));
  try {
    for(const {path,text} of snapshot){
      if(text===null)continue;
      await mkdir(dirname(join(dir,path)),{recursive:true});
      await writeFile(join(dir,path),text,{flag:'wx',mode:0o600});
    }
    await writeFile(join(dir,'AGENTS.md'),rules,{flag:'wx',mode:0o600});
    const read=async path=>{try{return await readFile(join(dir,path),'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
    const files=await Promise.all(snapshot.map(async({path})=>({path,text:await read(path)})));
    const outputs=await generate(files,await read('AGENTS.md'));signal.throwIfAborted();
    for(const {path,text} of outputs){
      if(text===null)await rm(join(dir,path),{force:true});
      else {await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),text,{mode:0o600});}
    }
    return {files:await Promise.all(snapshot.map(async({path})=>({path,text:await read(path)})))};
  } finally {await rm(dir,{recursive:true,force:true});}
}
