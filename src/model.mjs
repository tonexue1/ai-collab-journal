import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SYSTEM } from './trajectory.mjs';
export function modelGenerator(llm,route,sessionId,{system=SYSTEM}={}) {
  return async (input,signal) => {
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(90000)]);
    // Four bounded Chinese summaries plus details can exceed 2600 tokens.
    // Use the registered model's capacity and least reasoning effort for this auxiliary task.
    const call=await llm.prepareCall({...route,maxTokens:8192},deadline,(controls,model)=>({
      ...controls,maxTokens:Math.min(8192,model.maxTokens??8192),
      ...(model.reasoning?.efforts[0]?{reasoningEffort:model.reasoning.efforts[0].id}:{}),
    }));
    const assembler=new BlockAssembler();
    const options={...call.config,system,messages:[createUserMessage({content:[{type:'text',text:JSON.stringify(input)}],source:{kind:'dsh-collab-journal'}})],sessionId,purpose:'collab-journal',signal:deadline};
    for await(const chunk of call.stream(options)){deadline.throwIfAborted();assembler.push(chunk);}
    deadline.throwIfAborted();
    if(assembler.finish.kind!=='stop')throw new Error(assembler.finish.failure?.message||`解析模型未正常完成：${assembler.finish.kind}`);
    const blocks=assembler.blocks();
    if(blocks.some(b=>b.type==='tool-call'))throw new Error('解析模型返回了工具调用');
    return blocks.filter(b=>b.type==='text').map(b=>b.text).join('');
  };
}
