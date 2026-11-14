import {z} from 'zod';
import {OutputValidationError} from './output.mjs';

export const CATEGORIES=Object.freeze(['方向纠正','任务指挥','上下文补充','流程推进','授权选择','结果反馈','新任务','未判定']);
export const UNKNOWN_BEFORE='前文证据不足，无法确定介入前状态。';
export const FIRST_BEFORE='首次提出任务，之前没有可用交互记录。';
const normalized=text=>text.replace(/\s+/gu,' ').trim();
const text=max=>z.string().transform(normalized).pipe(z.string().min(1).max(max));
const citation=z.object({seq:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),quote:text(1000)}).strict();
const citations=z.array(citation).max(6);
const statement=z.object({text:text(240),evidence:citations}).strict();
export const interventionResultSchema=z.object({
  title:text(80),
  categories:z.array(z.object({label:z.enum(CATEGORIES),evidence:citations.min(1)}).strict()).min(1).max(3),
  before:statement,contribution:statement,certainty:z.enum(['supported','unclear']),
}).strict();
const needSchema=z.object({need:z.object({
  seqs:z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(8).optional(),
  query:text(160).optional(),
}).strict().refine(x=>x.seqs?.length||x.query,{message:'需要 seqs 或 query'})}).strict();
const fail=issues=>{throw new OutputValidationError(issues);};
const issue=(path,code,message)=>({path,code,message});

/** Shape validation is reusable for storage. Citation validation additionally
 * needs the exact text ranges sent to this call, never the unread source.
 */
export function validateInterventionResponse(raw,input){
  let value;
  try{value=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}
  catch{fail([issue('$','INVALID_JSON','必须返回完整 JSON 对象')]);}
  if(value&&typeof value==='object'&&Object.hasOwn(value,'need')){
    const parsed=needSchema.safeParse(value);
    if(!parsed.success)fail(parsed.error.issues.map(e=>issue(e.path.join('.')||'$','INVALID_NEED','补充读取请求结构不正确')));
    if(!input.reading.canReadMore)fail([issue('need','READ_LIMIT','本轮不能继续读取；请仅据已读证据返回结果，证据不足用未判定和明确未知')]);
    if(parsed.data.need.seqs?.some(seq=>!input.availableSeqs.has(seq)||seq>input.anchor.seq))fail([issue('need.seqs','UNKNOWN_SOURCE','只能读取当前人的表达及其之前实际存在的来源序号')]);
    return parsed.data;
  }
  const parsed=interventionResultSchema.safeParse(value);
  if(!parsed.success)fail(parsed.error.issues.slice(0,20).map(e=>issue(e.path.join('.')||'$','INVALID_FIELD','字段结构、长度或取值不符合约束')));
  const result=parsed.data,issues=[];
  const check=(list,path)=>{
    for(const [i,reference] of list.entries()){
      const provided=reference.seq===input.anchor.seq?[{seq:input.anchor.seq,text:input.anchor.text}]:input.evidence.filter(e=>e.seq===reference.seq);
      if(reference.seq>input.anchor.seq||!provided.length)issues.push(issue(`${path}[${i}].seq`,'SOURCE_NOT_READ','必须引用本轮已提供且不晚于当前人的表达的来源'));
      else if(!provided.some(e=>normalized(e.text).includes(reference.quote)))issues.push(issue(`${path}[${i}].quote`,'QUOTE_NOT_READ','引文必须是已提供的连续原文片段，不能跨越未读区间'));
    }
  };
  const labels=result.categories.map(c=>c.label);
  if(new Set(labels).size!==labels.length)issues.push(issue('categories','DUPLICATE_CATEGORY','类别不可重复'));
  if(labels.includes('未判定')&&(labels.length!==1||result.certainty!=='unclear'))issues.push(issue('categories','UNCLEAR_CATEGORY','未判定必须单独出现且 certainty 为 unclear'));
  for(const [i,category] of result.categories.entries())check(category.evidence,`categories[${i}].evidence`);
  check(result.before.evidence,'before.evidence');check(result.contribution.evidence,'contribution.evidence');
  if(!result.contribution.evidence.some(e=>e.seq===input.anchor.seq))issues.push(issue('contribution.evidence','MISSING_HUMAN_EVIDENCE','人的介入必须引用当前人的原话'));
  if(!result.before.evidence.length){
    const unknown=result.before.text===UNKNOWN_BEFORE&&result.certainty==='unclear';
    const first=input.isFirst&&input.coverage.totalEntries===1&&result.before.text===FIRST_BEFORE&&labels.includes('新任务');
    if(!unknown&&!first)issues.push(issue('before.evidence','MISSING_BEFORE_EVIDENCE','无前文证据时只能明确未知，或首条新任务注明无此前交互'));
  }
  if(issues.length)fail(issues.slice(0,20));
  return {result};
}
