import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { bounds,today,addDays,monday } from '../src/time.mjs';
import { contextFor,createServer } from '../src/server.mjs';
import { OpenCode } from '../src/opencode.mjs';
import { SaveState } from '../public/editor.js';
import { ROOT } from '../src/config.mjs';
const DAY='2026-06-03';
const summary={overview:'测试概况',observations:[],questions:[]};
function setup(t,day=DAY){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-regression-'));
  const store=new Store(path.join(dir,'journal.sqlite'));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});
  const config={root:ROOT,dataDir:dir,startDate:day,projects:['/fixture'],maxInputChars:8000,demo:false};
  const calls=[];
  const adapter={async collect(){calls.push({task:'collect'});return {directories:['/fixture']}},async analyze(task,data){
    calls.push({task,data});
    if(task==='daily-events'){
      const messages=[...(data.priorEvidence||[]),...data.messages],user=messages.find(m=>m.role==='user'&&m.targetDay);
      if(!user)return {events:[]};
      const result=data.messages.find(m=>m.text.includes('最终测试失败'));
      return {events:[{title:'验证修复',category:'流程推进',summary:'要求运行测试',intent:'验证质量',intervention:'要求验证',outcome:result?'失败':data.previousEvents?.[0]?.outcome||'未知',evidence:[{sessionId:user.sessionId,messageIds:[user.id,...(result?[result.id]:[])]}]}]};
    }
    if(task==='weekly')return {overview:'周概况',patterns:[],questions:[]};
    return summary;
  }};
  return {store,config,adapter,calls,engine:new Engine(config,store,adapter)};
}
const session={id:'source',directory:'/fixture',title:'合成来源'};
const message=(id,role,text,createdAt)=>({id,sessionId:session.id,role,createdAt,parts:[{type:'text',text}]});
function seed(store,day=DAY,text='修复后请运行测试'){
  const messages=[message('user','user',text,bounds(day).start+1000)];store.upsertSession(session,messages);return messages;
}
const reflect=(store,id,extra={})=>store.reflect(id,{note:'个人判断',category:'',follow:false,...extra});

test('长日志后出现的结局更新同一事件，并保留原锚点和最终依据',async t=>{
  const {store,engine}=setup(t),messages=seed(store);
  messages.push(message('log','assistant','日志'.repeat(15000),bounds(DAY).start+2000),message('end','assistant','最终测试失败',bounds(DAY).start+3000));store.upsertSession(session,messages);
  const r=await engine.start('daily',DAY,{collect:false}).done;
  assert.equal(r.events.length,1);assert.equal(r.events[0].outcome,'失败');assert.deepEqual(r.events[0].evidence[0].messageIds,['user','end']);
});

test('晚到的跨日结果刷新原日报，不冒充次日新增介入',async t=>{
  const day=addDays(today(),-2),next=addDays(day,1),{store,engine,calls}=setup(t,day);
  const messages=[message('user','user','请完成验证',bounds(day).end-60000)];store.upsertSession(session,messages);
  const first=await engine.start('daily',day,{collect:false}).done;assert.equal(first.events[0].outcome,'未知');
  messages.push(message('late','assistant','最终测试失败',bounds(next).start+3*3600000));store.upsertSession(session,messages);
  await engine.due();const updated=store.review(day);
  assert.equal(updated.events[0].id,first.events[0].id);assert.equal(updated.events[0].outcome,'失败');
  assert.equal(today(updated.events[0].lastEvidenceAt),next);assert.equal(store.review(next).events.length,0);
  const collections=calls.filter(c=>c.task==='collect').length;
  assert.equal((await engine.due()).length,0);assert.equal(calls.filter(c=>c.task==='collect').length,collections+1);
});

test('明确修正与否定在重跑、汇总和导出中采用同一事实',async t=>{
  const {store,engine,calls,config}=setup(t);seed(store);
  const first=await engine.start('daily',DAY,{collect:false}).done,id=first.events[0].id;
  reflect(store,id,{decision:'keep',overrides:{summary:'人工确认事实',outcome:'人工确认失败'}});
  assert.equal(store.review(DAY).stale,true);
  await engine.start('daily',DAY,{collect:false}).done;
  assert.equal(store.review(DAY).events[0].outcome,'人工确认失败');assert.equal(store.review(DAY).stale,false);
  assert.equal(calls.filter(c=>c.task==='daily-summary').at(-1).data.events[0].summary,'人工确认事实');
  assert.match(fs.readFileSync(path.join(config.dataDir,'daily',`${DAY}.md`),'utf8'),/人工确认失败/);
  reflect(store,id,{decision:'reject'});await engine.start('daily',DAY,{collect:false}).done;
  assert.equal(store.review(DAY).events.length,0);assert.equal(store.review(DAY).rejectedEvents[0].id,id);
  await engine.start('weekly',monday(DAY)).done;
  assert.equal(calls.filter(c=>c.task==='weekly').at(-1).data.reviews[0].events.length,0);
});

test('人工补记在模型重跑不再提取事件时仍保留，旧批注不混为现行事实',async t=>{
  const {store,engine,adapter,calls}=setup(t);seed(store);
  const first=await engine.start('daily',DAY,{collect:false}).done;reflect(store,first.events[0].id);
  const manual=engine.addManual({day:DAY,title:'漏记事件',summary:'我补充的事实',outcome:'未知',evidence:[{sessionId:'source',messageIds:['user']}]});
  const original=adapter.analyze;adapter.analyze=async(task,data)=>task==='daily-events'?{events:[]}:original(task,data);
  await engine.start('daily',DAY,{collect:false}).done;
  const r=store.review(DAY);assert.deepEqual(r.events.map(e=>e.id),[manual.id]);assert.equal(r.retiredEvents.length,1);
  await engine.start('weekly',monday(DAY)).done;
  assert.deepEqual(calls.filter(c=>c.task==='weekly').at(-1).data.reviews[0].events.map(e=>e.id),[manual.id]);
});

test('周比较保留意图、介入、结果和证据，人工变化使其过期',async t=>{
  const {store,engine,calls}=setup(t);seed(store);await engine.start('daily',DAY,{collect:false}).done;
  const week=await engine.start('weekly',monday(DAY)).done;
  const event=calls.filter(c=>c.task==='weekly').at(-1).data.reviews[0].events[0];
  for(const key of ['intent','intervention','outcome','evidence'])assert(key in event);
  assert.equal(store.weeks()[0].stale,false);reflect(store,event.id,{overrides:{outcome:'改为失败'}});assert.equal(store.weeks()[0].stale,true);
  await engine.start('daily',DAY,{collect:false}).done;const next=await engine.start('weekly',monday(DAY)).done;
  assert.notEqual(next.id,week.id);assert.equal(store.weekHistory(week.start).length,2);assert.equal(store.weeks()[0].stale,false);
});

test('旧周报始终回查原版本证据，机器依据变化不会静默沿用人工核对',async t=>{
  const {store,engine}=setup(t);seed(store,DAY,'V1 原文');
  const first=await engine.start('daily',DAY,{collect:false}).done,id=first.events[0].id;
  reflect(store,id,{decision:'keep',basedOnRevision:first.events[0].revision});
  const week=await engine.start('weekly',monday(DAY)).done;
  seed(store,DAY,'V2 原文');await engine.start('daily',DAY,{collect:false}).done;
  assert.equal(store.event(id).needsReview,true);assert.equal(store.weeks()[0].stale,true);
  assert.equal(contextFor(store,id,{weekId:week.id}).messages[0].parts[0].text,'V1 原文');
  assert.equal(contextFor(store,id).messages[0].parts[0].text,'V2 原文');
  const revision=store.event(id).revision;await engine.start('daily',DAY,{collect:false}).done;assert.equal(store.event(id).revision,revision);
});

test('过期的批注写入被拒绝，不覆盖另一个页面的较新内容',async t=>{
  const {store,engine}=setup(t);seed(store);const id=(await engine.start('daily',DAY,{collect:false}).done).events[0].id;
  reflect(store,id,{note:'第一版',expectedVersion:0});
  assert.throws(()=>reflect(store,id,{note:'过期覆盖',expectedVersion:0}),/其他页面/);
  assert.equal(store.event(id).reflection.note,'第一版');
});

test('模型汇总期间新增的个人判断不会被误标为已经纳入概况',async t=>{
  const {store,engine,adapter}=setup(t);seed(store);const id=(await engine.start('daily',DAY,{collect:false}).done).events[0].id;
  let entered,release;const ready=new Promise(r=>entered=r),old=adapter.analyze;
  adapter.analyze=async(task,data)=>{if(task==='daily-summary'){entered();await new Promise(r=>release=r);}return old(task,data)};
  const run=engine.start('daily',DAY,{collect:false});await ready;reflect(store,id,{note:'生成期间新写的思考'});release();await run.done;
  assert.equal(store.review(DAY).stale,true);assert.equal(store.event(id).reflection.note,'生成期间新写的思考');
});

test('单日失败不阻塞后续日期，补跑只采集一次并保留失败状态',async t=>{
  const day=addDays(today(),-3),{store,engine,calls}=setup(t,day),old=engine.daily.bind(engine);
  engine.daily=async(date,...args)=>{if(date===day)throw new Error('当天材料过大');return old(date,...args)};
  await assert.rejects(engine.due(),/补跑部分失败/);
  assert.equal(calls.filter(c=>c.task==='collect').length,1);assert.equal(store.review(day),null);
  assert(store.review(addDays(day,1)).complete);assert(store.review(addDays(day,2)).complete);
  assert(store.runs().some(r=>r.scope===day&&r.status==='failed'));
});

test('全局模型失败停止整批，避免每个日期重复请求',async t=>{
  const day=addDays(today(),-3),{store,engine,adapter,calls}=setup(t,day);seed(store,day);
  adapter.analyze=async()=>{calls.push({task:'global-failure'});throw Object.assign(new Error('认证不可用'),{scope:'global'})};
  await assert.rejects(engine.due(),/认证/);assert.equal(calls.filter(c=>c.task==='global-failure').length,1);assert.equal(store.review(addDays(day,1)),null);
});

test('HTTP 支持未被 AI 选中的原文、补记以及固定版本证据',async t=>{
  const {store,engine,config,adapter}=setup(t);seed(store);adapter.analyze=async task=>task==='daily-events'?{events:[]}:task==='weekly'?{overview:'周',patterns:[],questions:[]}:summary;
  await engine.start('daily',DAY,{collect:false}).done;
  const app=createServer(config,store,engine);await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
  const base=`http://127.0.0.1:${app.address().port}`,api=async(url,options)=>{const r=await fetch(base+url,options);assert(r.ok,await r.clone().text());return r.json()};
  assert.equal((await api('/api/sessions?day='+DAY))[0].messages[0].id,'user');
  const event=await api('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({day:DAY,title:'补记',summary:'原文中确有此事',evidence:[{sessionId:'source',messageIds:['user']}]})});
  const week=await engine.start('weekly',monday(DAY)).done;
  assert.equal((await api(`/api/weeks/${week.id}/events/${event.id}`)).origin,'human');
  assert.equal((await api(`/api/events/${event.id}/context?weekId=${week.id}`)).messages[0].id,'user');
});

function uiSaveFixture(){
  const source=fs.readFileSync(path.join(ROOT,'public/app.js'),'utf8'),from=source.indexOf('async function saveReflection(){'),to=source.indexOf('async function startRun(',from);
  const fields={note:{value:'第一版'},category:{value:''},follow:{checked:false},decision:{value:'unreviewed'},'edit-summary':{value:''},'edit-outcome':{value:''},'save-status':{textContent:''},'save-reflection':{disabled:false},'summary-stale':{hidden:true}};
  const state={event:{id:'abc',revision:1,reflection:{version:0}},tab:'reflection',dirty:true},editor=new SaveState();let resolve,saved,count=0;
  const api=(_url,_method,input)=>{saved=input;count++;const event=state.event;return new Promise(r=>resolve=()=>r({event:{...event,reflection:{...input,version:1}}}))};
  const save=new Function('state','editor','document','api','toast',source.slice(from,to)+';return saveReflection;')(state,editor,{getElementById:id=>fields[id]},api,()=>{});
  return {state,editor,fields,save,complete:()=>resolve(),saved:()=>saved,count:()=>count};
}
test('保存期间继续输入，真实页面保存函数保留未保存标记且不并发提交',async()=>{
  const f=uiSaveFixture(),pending=f.save();f.fields.note.value='第二版';f.editor.changed();f.state.dirty=true;
  await f.save();assert.equal(f.count(),1);f.complete();await pending;
  assert.equal(f.saved().note,'第一版');assert.equal(f.fields.note.value,'第二版');assert.equal(f.state.dirty,true);assert.match(f.fields['save-status'].textContent,/当前修改尚未保存/);
});
test('保存未再编辑时清除标记，切换事件后不改写新事件的状态',async()=>{
  const first=uiSaveFixture(),pending=first.save();first.complete();await pending;assert.equal(first.state.dirty,false);
  const second=uiSaveFixture(),old=second.save();second.state.event={id:'def',reflection:{}};second.editor.changed();second.state.dirty=true;second.complete();await old;assert.equal(second.state.dirty,true);assert.equal(second.fields['save-status'].textContent,'');
});

test('doctor 只输出模型标识和配置范围，绝不泄露 provider 凭证',async t=>{
  const {config,store}=setup(t),fake=async(_command,args)=>({stdout:args[0]==='--version'?'1.19.5':args[0]==='--help'?'opencode export':JSON.stringify({model:'fixture/reviewer',provider:{fixture:{options:{apiKey:'NEVER-PRINT-THIS'}}}})});
  const result=await new OpenCode(config,store,fake).doctor();assert.equal(result.model,'fixture/reviewer');assert.doesNotMatch(JSON.stringify(result),/NEVER-PRINT/);assert.match(result.configuration,/不继承/);
});
