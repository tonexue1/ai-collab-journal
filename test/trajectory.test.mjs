import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {ROOT} from '../src/config.mjs';
import {createServer} from '../src/server.mjs';
import {workspaceCatalog,trajectoryNodes,trajectoryReport,trajectoryContext,analyzeTrajectory} from '../src/trajectory.mjs';
const source={id:'conversation',directory:'/work/one/app',title:'购买入口收敛'};
const msg=(id,role,text,offset)=>({id,sessionId:source.id,role,createdAt:Date.parse('2026-11-06T15:59:00Z')+offset*60000,parts:[{type:'text',text}]});
const samples=()=>[msg('u1','user','先梳理入口',0),msg('a1','assistant','准备读文件',0.5),msg('a2','assistant','发现两个入口',2),msg('u2','user','只改购买入口',3),msg('u3','user','不要改容器',4),msg('a3','assistant','修改已执行，测试失败',5)];
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-trajectories-')),store=new Store(path.join(dir,'journal.sqlite'));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});
  const config={root:ROOT,dataDir:dir,projects:[],maxInputChars:8000,demo:false},calls=[];
  const adapter={async collect(){calls.push({task:'collect'});store.upsertSession(source,samples());return {imported:1}},async analyze(task,data){calls.push({task,data});return {items:data.items.map(item=>({id:item.id,summary:task==='trajectory'?item.text.slice(-120):item.fragments.map(f=>f.summary).join('；').slice(-170),details:[]}))};}};
  store.upsertSession(source,samples());return {config,store,adapter,calls,engine:new Engine(config,store,adapter)};
}
test('workspace 完整路径分组，分析与子会话排除，空项目保留',t=>{
  const {store,config}=setup(t);
  store.upsertSession({...source,id:'two',directory:'/work/two/app'},[msg('b','user','另一项目',100)]);
  store.upsertSession({...source,id:'child',parentID:source.id},[]);
  store.upsertSession({...source,id:'analysis',title:'[collab-review] trajectory'},[]);
  store.upsertSession({...source,id:'excluded'},[]);store.exclude('excluded');
  let result=workspaceCatalog(store,config);assert.equal(result.workspaces.length,2);assert.equal(result.workspaces[0].name,result.workspaces[1].name);
  assert.deepEqual(result.workspaces.flatMap(w=>w.sessions.map(s=>s.id)),['conversation','two']);
  config.projects=['/work/one/app','/empty'];result=workspaceCatalog(store,config);
  assert.equal(result.workspaces.length,2);assert.equal(result.workspaces.find(w=>w.directory==='/empty').sessions.length,0);
  assert.equal(result.workspaces.flatMap(w=>w.sessions).length,1);
});
test('逐次保留人类发言，合并连续 AI，跨午夜不中断',()=>{
  const nodes=trajectoryNodes(samples());assert.deepEqual(nodes.map(n=>n.role),['user','assistant','user','user','assistant']);
  assert.deepEqual(nodes[1].messageIds,['a1','a2']);assert.equal(nodes[1].endedAt-nodes[1].startedAt,90000);
  assert.deepEqual(nodes.flatMap(n=>n.messageIds),samples().map(m=>m.id));
});
test('解析持久化，快照不随原文漂移，新增内容及失败保留上次结果',async t=>{
  const {store,config,engine,adapter}=setup(t);
  assert.equal(trajectoryReport(store,config,source.id),null);
  const report=await engine.start('trajectory',source.id).done;assert.equal(report.nodes.length,5);assert.equal(trajectoryReport(store,config,source.id).stale,false);
  const changed=samples();changed[0].parts[0].text='修改后的新原文';store.upsertSession(source,changed);
  assert.equal(trajectoryReport(store,config,source.id).stale,true);
  const newer=await engine.start('trajectory',source.id).done;assert.notEqual(newer.snapshotId,report.snapshotId);
  assert.equal(trajectoryContext(store,config,source.id,'n1',report.snapshotId).messages[0].parts[0].text,'先梳理入口');
  adapter.analyze=async()=>{throw Object.assign(new Error('模型不可用'),{scope:'global'})};
  await assert.rejects(engine.start('trajectory',source.id).done,/模型不可用/);assert.deepEqual(store.trajectory(source.id),newer);
  assert(store.runs().some(r=>r.kind==='trajectory'&&r.status==='failed'));
  const reopened=new Store(path.join(config.dataDir,'journal.sqlite'));assert.equal(reopened.trajectory(source.id).snapshotId,newer.snapshotId);reopened.close();
});
test('长工具输出完整分片，预算受控，末尾失败进入最终节点',async t=>{
  const {adapter,calls}=setup(t),messages=samples().slice(0,2),text='\\"日志\n'.repeat(9000)+'最终测试失败';
  messages[1].parts=[{type:'tool',tool:'bash',state:{output:text}}];
  const nodes=await analyzeTrajectory(adapter,messages,8000);
  const parts=calls.filter(c=>c.task==='trajectory').flatMap(c=>c.data.items).filter(item=>item.messageId==='a1');
  assert.equal(parts.map(p=>p.text).join(''),'[工具 bash] '+JSON.stringify({output:text}));
  assert.match(nodes[1].summary,/最终测试失败/);assert.equal(nodes[1].toolCount,1);assert(calls.every(c=>JSON.stringify(c.data).length<=8000));
});
test('拒绝遗漏、重复、伪造与过长摘要，失败释放锁',async t=>{
  const {engine,adapter,store}=setup(t);
  for(const kind of ['missing','duplicate','unknown','long']){
    adapter.analyze=async(_task,data)=>({items:kind==='missing'?[]:data.items.map(item=>({id:kind==='unknown'?'invented':kind==='duplicate'?data.items[0].id:item.id,summary:kind==='long'?'x'.repeat(181):'摘要',details:[]}))});
    await assert.rejects(engine.start('trajectory',source.id).done,/模型输出校验失败/);assert.equal(store.trajectory(source.id),null);
  }
});
test('同步与浏览不调用模型，并发拒绝，解析期间新消息提示更新',async t=>{
  const {engine,store,config,adapter,calls}=setup(t);
  await engine.start('collect').done;workspaceCatalog(store,config);assert.deepEqual(calls.map(c=>c.task),['collect']);
  let entered,release;const ready=new Promise(r=>entered=r),old=adapter.analyze;let first=true;
  adapter.analyze=async(...args)=>{if(first){first=false;entered();await new Promise(r=>release=r);}return old(...args)};
  const job=engine.start('trajectory',source.id);await ready;assert.throws(()=>engine.start('collect'),/正在执行/);
  store.upsertSession(source,[...samples(),msg('late','assistant','测试最终通过',20)]);release();await job.done;
  assert.equal(trajectoryReport(store,config,source.id).stale,true);
});
test('HTTP 目录、手动任务、原文快照、资源与范围隔离',async t=>{
  const {config,store,engine,calls}=setup(t),server=createServer(config,store,engine);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`,get=async url=>(await fetch(base+url)).json();
  assert.equal((await get('/api/workspaces')).workspaces.length,1);assert.equal(await get('/api/trajectories/conversation'),null);assert.equal(calls.length,0);
  const response=await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'trajectory',sessionId:source.id})});assert.equal(response.status,202);
  const {id}=await response.json();for(let i=0;i<50&&store.runs().find(r=>r.id===id).status==='running';i++)await new Promise(r=>setTimeout(r,5));
  const report=await get('/api/trajectories/conversation');assert.equal(report.nodes.length,5);
  assert.equal((await get(`/api/trajectories/conversation/context?node=n2&snapshot=${report.snapshotId}`)).highlight.length,2);
  assert.equal((await fetch(base+'/trajectories.js')).status,200);assert.equal((await fetch(base+'/trajectory.css')).status,200);
  assert.equal((await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://untrusted.invalid'},body:'{"kind":"collect"}'})).status,403);
  config.projects=['/elsewhere'];assert.equal((await get('/api/workspaces')).workspaces[0].sessions.length,0);
  assert.equal((await fetch(base+'/api/trajectories/conversation')).status,400);assert.throws(()=>engine.start('trajectory',source.id),/范围/);
});
