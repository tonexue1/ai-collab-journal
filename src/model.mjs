import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SYSTEM } from './trajectory.mjs';
export function modelGenerator(llm,route,sessionId) {
  return async (input,signal) => {
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(90000)]);
    const call=await llm.prepareCall({...route,maxTokens:2600},deadline);
    const assembler=new BlockAssembler();
    const options={...call.config,system:SYSTEM,messages:[createUserMessage({content:[{type:'text',text:JSON.stringify(input)}],source:{kind:'dsh-collab-journal'}})],sessionId,purpose:'collab-journal',signal:deadline};
    for await(const chunk of call.stream(options)){deadline.throwIfAborted();assembler.push(chunk);}
    deadline.throwIfAborted();
    if(assembler.finish.kind!=='stop')throw new Error(`解析模型未正常完成：${assembler.finish.kind}`);
    const blocks=assembler.blocks();
    if(blocks.some(b=>b.type==='tool-call'))throw new Error('解析模型返回了工具调用');
    return blocks.filter(b=>b.type==='text').map(b=>b.text).join('');
  };
}
