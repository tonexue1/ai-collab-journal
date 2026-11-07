import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { OpenCode, normalizeExport } from './opencode.mjs';
import { DemoAdapter } from './demo.mjs';
import { Engine } from './engine.mjs';
import { createServer } from './server.mjs';
import { today,addDays,monday } from './time.mjs';

const args=process.argv.slice(2), command=args.shift()||'serve';
const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]};
let store;
try{
  const config=loadConfig({demo:args.includes('--demo'),dataDir:value('--data-dir')});
  if(value('--port')){config.port=Number(value('--port'));if(!Number.isInteger(config.port)||config.port<1||config.port>65535)throw new Error('无效端口');}
  store=new Store(path.join(config.dataDir,'journal.sqlite'));
  const adapter=config.demo?new DemoAdapter(store):new OpenCode(config,store),engine=new Engine(config,store,adapter);
  if(command==='serve'){
    if(config.demo&&!store.review(today())){await engine.start('daily',addDays(today(),-1)).done;await engine.start('daily',today()).done;}
    const server=createServer(config,store,engine);
    server.on('error',error=>{console.error(`无法启动服务：${error.message}`);store.close();process.exitCode=1});
    server.listen(config.port,'127.0.0.1',()=>console.log(`协作观察 ${config.demo?'（演示模式）':''} http://127.0.0.1:${config.port}`));
    const shutdown=()=>{server.close(()=>{store.close();process.exit(0)});};
    process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  }else if(command==='review'){
    const day=value('--date')||addDays(today(),-1);await engine.start('daily',day,{collect:!args.includes('--offline')}).done;console.log(`日记已生成：${day}`);store.close();
  }else if(command==='weekly'){
    const start=value('--start')||monday(addDays(today(),-7));await engine.start('weekly',start).done;console.log(`周总结已生成：${start}`);store.close();
  }else if(command==='due'){
    const logfile=path.join(config.dataDir,'schedule.log');
    fs.appendFileSync(logfile,`${new Date().toISOString()} START\n`);
    try{const results=await engine.due();fs.appendFileSync(logfile,`${new Date().toISOString()} SUCCESS ${results.length}\n`);console.log(`补跑完成：${results.length} 项`)}
    catch(error){fs.appendFileSync(logfile,`${new Date().toISOString()} FAILED ${error.message}\n`);throw error}
    store.close();
  }else if(command==='import'){
    const filename=value('--file');if(!filename)throw new Error('需要 --file <OpenCode 导出 JSON>');
    const item=normalizeExport(JSON.parse(fs.readFileSync(filename,'utf8')));store.upsertSession(item.session,item.messages);console.log(`导入 ${item.messages.length} 条消息`);store.close();
  }else if(command==='doctor'){
    console.log(JSON.stringify(await (adapter.doctor?adapter.doctor():adapter.probe()),null,2));store.close();
  }else throw new Error('命令：serve | review --date YYYY-MM-DD | weekly --start YYYY-MM-DD | due | import --file export.json | doctor');
}catch(error){console.error(error.message);try{store?.close()}catch{}process.exitCode=1;}
