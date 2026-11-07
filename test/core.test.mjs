import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { bounds,today,addDays,monday } from '../src/time.mjs';
import { normalizeExport, modelText, OpenCode, runProcess } from '../src/opencode.mjs';
import { prepareBatches,validateEvents } from '../src/analysis.mjs';
import { Engine } from '../src/engine.mjs';
import { contextFor } from '../src/server.mjs';
import { ROOT, matchesProject } from '../src/config.mjs';
const DAY='2026-06-03';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collab-test-'));const store=new Store(path.join(dir,'journal.sqlite'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});const config={dataDir:dir,root:ROOT,startDate:DAY,projects:['/project'],maxInputChars:8000,demo:false};return{store,config};}
function fixture(){const {start,end}=bounds(DAY);return{info:{id:'old-session',title:'老会话',directory:'/project',time:{created:start-86400000*8}},messages:[
 {info:{id:'old',role:'user',time:{created:start-1000}},parts:[{type:'text',text:'昨天的方案'}]},
 {info:{id:'today',role:'user',time:{created:start}},parts:[{type:'text',text:'今天继续，按第二种方案改'}]},
 {info:{id:'answer',role:'assistant',time:{created:start+1000}},parts:[{type:'text',text:'好的'}]},
 {info:{id:'tomorrow',role:'user',time:{created:end}},parts:[{type:'text',text:'明天再补充'}]}
]};}
const output=()=>({events:[{title:'补充决策',category:'任务指挥',summary:'用户选择方案',intent:'继续任务',intervention:'指定第二种方案',outcome:'未知',evidence:[{sessionId:'old-session',messageIds:['today','answer']}]}]});
const summary={overview:'用户今天继续了已有任务。',observations:[],questions:[]};
function adapter(){return{async collect(){return{directories:['/project']}},async analyze(task){return task==='daily-events'?output():task==='weekly'?{overview:'本周观察',patterns:[],questions:[]}:summary}}}

test('北京日期边界及周一起点',()=>{const{start,end}=bounds(DAY);assert.equal(today(start-1),'2026-06-02');assert.equal(today(start),DAY);assert.equal(today(end),'2026-06-04');assert.equal(monday(DAY),'2026-06-01');assert.throws(()=>bounds('2026-02-30'));});
test('老会话今天的消息入选，跨日背景保留但不计入当天',t=>{const{store,config}=setup(t);const item=normalizeExport(fixture());store.upsertSession(item.session,item.messages);const{batches,stats}=prepareBatches(store,DAY,config);assert.equal(stats.messages,2);assert.equal(stats.userMessages,1);assert.equal(batches[0].messages.find(m=>m.id==='old').targetDay,false);assert.equal(batches[0].messages.find(m=>m.id==='today').targetDay,true);assert.equal(batches[0].messages.find(m=>m.id==='tomorrow').targetDay,false);});
test('拒绝缺少时间的导出，防止悄悄漏采',()=>{const input=fixture();delete input.messages[0].info.time;assert.throws(()=>normalizeExport(input),/时间/)});
test('拒绝伪造证据以及把昨天的用户消息当作今天事件',t=>{const{store,config}=setup(t);const item=normalizeExport(fixture());store.upsertSession(item.session,item.messages);const batch=prepareBatches(store,DAY,config).batches[0];const r=output();r.events[0].evidence[0].messageIds=['missing'];assert.throws(()=>validateEvents(r,batch,DAY,store),/之外/);r.events[0].evidence[0].messageIds=['old'];assert.throws(()=>validateEvents(r,batch,DAY,store),/当天/);});
test('日记重跑保留批注；事件消失后旧批注仍可访问',async t=>{const{store,config}=setup(t);const item=normalizeExport(fixture());store.upsertSession(item.session,item.messages);const a=adapter(),engine=new Engine(config,store,a);const first=await engine.start('daily',DAY,{collect:false}).done;const id=first.events[0].id;store.reflect(id,{note:'这是正常决策',category:'判断取舍',follow:true});const second=await engine.start('daily',DAY,{collect:false}).done;assert.equal(second.events[0].reflection.note,'这是正常决策');a.analyze=async task=>task==='daily-events'?{events:[]}:summary;const third=await engine.start('daily',DAY,{collect:false}).done;assert.equal(third.events.length,0);assert.equal(third.retiredEvents[0].reflection.note,'这是正常决策');assert.equal(contextFor(store,id,{full:true}).messages.length,4);});
test('分析失败不覆盖已生成日记，且记录失败并释放锁',async t=>{const{store,config}=setup(t);const item=normalizeExport(fixture());store.upsertSession(item.session,item.messages);const a=adapter(),engine=new Engine(config,store,a);const first=await engine.start('daily',DAY,{collect:false}).done;a.analyze=async()=>{throw new Error('模拟模型服务失败')};await assert.rejects(engine.start('daily',DAY,{collect:false}).done,/模拟/);assert.equal(store.review(DAY).generatedAt,first.generatedAt);assert.equal(store.runs()[0].status,'failed');const release=store.lock();release();});
test('禁止并发复盘',async t=>{const{store,config}=setup(t);let finish;const a={collect:()=>new Promise(resolve=>finish=resolve),analyze:async()=>summary},engine=new Engine(config,store,a);const job=engine.start('daily',DAY);assert.throws(()=>engine.start('daily',DAY),/正在执行/);finish({});await job.done;});
test('长消息分段但不丢正文，目标消息归属保持不变',t=>{const{store,config}=setup(t);const input=fixture();input.messages[1].parts[0].text='长'.repeat(25000);const item=normalizeExport(input);store.upsertSession(item.session,item.messages);const{batches}=prepareBatches(store,DAY,config);const parts=batches.flatMap(b=>b.messages).filter(m=>m.id==='today');assert.equal(parts.map(m=>m.text).join('').length,25000);assert(parts.every(m=>m.targetDay));assert(batches.every(b=>JSON.stringify(b.messages).length<config.maxInputChars+500));});
test('解析 CLI JSON 事件，排除分析会话；拒绝错误事件',()=>{const ids=[];const result=modelText([JSON.stringify({type:'step_start',sessionID:'analysis'}),JSON.stringify({type:'text',part:{text:'```json\n{"events":[]}\n```'}})].join('\n'),id=>ids.push(id));assert.deepEqual(result,{events:[]});assert.deepEqual(ids,['analysis']);assert.throws(()=>modelText('{"type":"error"}'),/调用失败/)});
test('CLI 自动区分 export 命令，采集不按会话创建日期过滤',async t=>{const{store,config}=setup(t);const calls=[];const fake=async(command,args)=>{calls.push(args);if(args[0]==='--version')return{stdout:'1.1.48'};if(args[0]==='--help')return{stdout:'opencode export [sessionID]'};if(args[0]==='session')return{stdout:JSON.stringify([{id:'old-session',title:'老会话',directory:'/project'},{id:'auto',title:'[collab-review] daily'}])};return{stdout:JSON.stringify(fixture())}};const oc=new OpenCode({...config,runnerDir:config.dataDir,opencodeCommand:'opencode',maxSessions:1000},store,fake);const stats=await oc.collect();assert.equal(stats.imported,1);assert.equal(stats.excluded,1);assert(calls.some(a=>a[0]==='export'&&a[1]==='old-session'));assert.equal(store.dayMessages(DAY).length,2)});
test('部分会话采集失败不能伪装完整日报',async t=>{const{store,config}=setup(t);const fake=async(command,args)=>{if(args[0]==='--version')return{stdout:'test'};if(args[0]==='--help')return{stdout:'opencode export'};if(args[0]==='session')return{stdout:'[{"id":"broken"}]'};throw new Error('读取失败')};await assert.rejects(new OpenCode({...config,maxSessions:10},store,fake).collect(),/读取失败/)});
test('补跑昨天暂稿，完成后重复 due 不再生成重复日记',async t=>{const{store,config}=setup(t);const yesterday=addDays(today(),-1);config.startDate=yesterday;const engine=new Engine(config,store,adapter());store.saveReview({day:yesterday,complete:false,events:[],generatedAt:1},[]);const first=await engine.due();assert(first.length>=1);assert.equal(store.review(yesterday).complete,true);assert.equal((await engine.due()).length,0)});
test('周总结拒绝单日事件冒充跨日模式',async t=>{const{store,config}=setup(t);const input=normalizeExport(fixture());store.upsertSession(input.session,input.messages);const a=adapter(),engine=new Engine(config,store,a);const daily=await engine.start('daily',DAY,{collect:false}).done;a.analyze=async()=>({overview:'错误模式',patterns:[{title:'重复',observation:'据称重复',eventIds:[daily.events[0].id]}],questions:[]});await assert.rejects(engine.start('weekly',monday(DAY)).done,/至少需要来自两天/);assert.equal(store.weeks().length,0)});

test('后续导入修改原文不改变已有事件的证据快照',async t=>{
  const {store,config}=setup(t),input=normalizeExport(fixture());
  store.upsertSession(input.session,input.messages);
  const report=await new Engine(config,store,adapter()).start('daily',DAY,{collect:false}).done;
  const id=report.events[0].id;
  input.messages.find(m=>m.id==='today').parts[0].text='后续修改';
  store.upsertSession(input.session,input.messages);
  assert.equal(contextFor(store,id,{full:true}).messages.find(m=>m.id==='today').parts[0].text,'今天继续，按第二种方案改');
});
test('子代理会话保留原文，但不作为人的当天介入',t=>{
  const {store,config}=setup(t),raw=fixture();raw.info.parentID='parent';
  const input=normalizeExport(raw);store.upsertSession(input.session,input.messages);
  assert.equal(store.messages('old-session').length,4);
  assert.equal(prepareBatches(store,DAY,config).batches.length,0);
});
test('导出失败回滚新日记，原日记和批注仍保留',async t=>{
  const {store,config}=setup(t),input=normalizeExport(fixture());store.upsertSession(input.session,input.messages);
  const engine=new Engine(config,store,adapter()),first=await engine.start('daily',DAY,{collect:false}).done;
  store.reflect(first.events[0].id,{note:'保留我',category:'',follow:false});
  engine.writeDaily=()=>{throw new Error('模拟磁盘写入失败')};
  await assert.rejects(engine.start('daily',DAY,{collect:false}).done,/磁盘/);
  assert.equal(store.review(DAY).generatedAt,first.generatedAt);
  assert.equal(store.review(DAY).events[0].reflection.note,'保留我');
});

test('未配置采集项目时明确失败，不能把分析目录误报为全部历史',async t=>{
  const {store,config}=setup(t);config.projects=[];
  await assert.rejects(new OpenCode(config,store).collect(),/projects/);
});

test('分别在两个项目目录枚举，空 stdout 表示无会话',async t=>{
  const {store,config}=setup(t);config.projects=['/one','/two'];const directories=[];
  const fake=async(command,args,options)=>{
    if(args[0]==='--version')return{stdout:'1.1.48'};
    if(args[0]==='--help')return{stdout:'opencode export'};
    directories.push(options.cwd);return{stdout:''};
  };
  const result=await new OpenCode({...config,maxSessions:10},store,fake).collect();
  assert.deepEqual(directories,['/one','/two']);assert.equal(result.imported,0);
  assert.deepEqual(result.scannedProjects,['/one','/two']);
});

test('新版 CLI 把帮助写到 stderr 时仍能探测导出命令',async t=>{
  const {store,config}=setup(t);
  const fake=async(command,args)=>args[0]==='--version'?{stdout:'1.19.5'}:{stdout:'',stderr:'opencode export [sessionID]'};
  assert.equal((await new OpenCode(config,store,fake).probe()).exportCommand,'export');
});

test('子进程的 PWD 与实际工作目录一致，隔离分析配置不会丢失',async t=>{
  const {config}=setup(t),file=path.join(config.dataDir,'cwd-probe.mjs');
  fs.writeFileSync(file,'console.log(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD}))');
  const result=JSON.parse((await runProcess(process.execPath,[file],{cwd:config.dataDir})).stdout);
  assert.equal(result.pwd,result.cwd);
});

test('Windows 项目路径忽略盘符大小写、分隔符和末尾斜杠差异',()=>{
  assert(matchesProject('C:/work/app',['c:\\work\\app\\'],'win32'));
  assert(!matchesProject('C:/work/app2',['c:\\work\\app'],'win32'));
});

test('项目目录别名与 OpenCode 返回的真实路径匹配',t=>{
  const {config}=setup(t),project=path.join(config.dataDir,'project'),alias=path.join(config.dataDir,'alias');
  fs.mkdirSync(project);fs.symlinkSync(project,alias,process.platform==='win32'?'junction':'dir');
  assert(matchesProject(project,[alias]));
});
