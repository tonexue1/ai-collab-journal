import { addDays, today, bounds } from './time.mjs';
import { normalizeExport } from './opencode.mjs';
export function seedDemo(store) {
  const day=today(), previous=addDays(day,-1), created=bounds(addDays(day,-7)).start;
  const samples=[
    ['方向校准','澄清跳转方式的收敛范围','流量购买的 H5 跳转方式应该收敛。','我理解为统一 H5 容器，准备调整容器结构。','我指的是购买入口的跳转方式，先把各入口梳理清楚。'],
    ['任务指挥','指定跨端对照的调查路径','先看安卓如何实现 push，再看鸿蒙缺失什么 API。','我会先对照调用链，再列出接口差异。','先输出接口差异表，未确认的部分单独列出。'],
    ['流程推进','补充代码完成后的收尾步骤','代码完成后，请检查并清理无用注释。','我会检查本次变更中的注释，保留必要背景说明。','把清理范围和验证结果一起给我。']
  ];
  samples.forEach((s,index)=>{
    const id=`demo-session-${index}`,messages=[];
    for(const d of [previous,day]){
      const base=bounds(d).start+9*3600000+index*3600000;
      [ ['user','先了解这项任务的现状。'], ['assistant','我会先梳理现状，再确定修改范围。'], ['user',s[2]], ['assistant',s[3]], ['user',s[4]], ['assistant','后续执行结果尚未包含在这个演示片段中。'] ].forEach(([role,text],i)=>messages.push({info:{id:`demo-${d}-${index}-${i}`,role,time:{created:base+i*60000}},parts:[{type:'text',text}]}));
    }
    const item=normalizeExport({info:{id,directory:index===1?'demo/harmony-push':'demo/vehicle-manager',title:`演示 · ${s[1]}`,time:{created,updated:Date.now()}},messages});
    store.upsertSession(item.session,item.messages);
  });
}
export class DemoAdapter {
  constructor(store){this.store=store;}
  async collect(){seedDemo(this.store);return {source:'演示数据（非真实历史、未调用模型）',listed:3,imported:3,excluded:0,directories:['demo/vehicle-manager','demo/harmony-push']};}
  async analyze(task,data){
    if(task==='trajectory'||task==='trajectory-merge')return {items:data.items.map(item=>({id:item.id,
      summary:task==='trajectory'?item.text.slice(0,110):item.fragments.map(f=>f.summary).join('；').slice(0,170),details:[]}))};
    if(task==='daily-events'){
      const m=data.messages.find(m=>m.targetDay&&m.role==='user'&&/应该收敛|先看安卓|清理无用注释/.test(m.text));
      if(!m)return {events:[]};
      const idx=Number(m.sessionId.split('-').at(-1));
      const titles=['澄清跳转方式的收敛范围','指定跨端对照的调查路径','补充代码完成后的收尾步骤'];
      return {events:[{title:titles[idx],category:['方向校准','任务指挥','流程推进'][idx],summary:['在演示对话中，用户纠正了 AI 对收敛范围的理解。','在演示对话中，用户指定了跨端对照的调查顺序。','在演示对话中，用户补充了清理注释的收尾要求。'][idx],intent:m.text,intervention:['澄清所指的范围','给出参考对象与调查顺序','补充完成标准'][idx],outcome:'未知；这是演示数据',evidence:[{sessionId:m.sessionId,messageIds:[m.id]}]}]};
    }
    if(task==='daily-summary')return {overview:'这份演示展示三类协作行为：纠正理解、指定调查路径、推动收尾。你可以核对上下文，再补充自己的判断。',observations:['用户介入可能是正常决策，不能直接视为 AI 出错或可省掉的劳动。'],questions:['哪些背景信息或完成标准需要反复提醒？']};
    return {overview:'这是演示模式的周总结，未调用真实模型。',patterns:[],questions:['积累更多真实记录后，再判断是否存在跨日模式。']};
  }
}
