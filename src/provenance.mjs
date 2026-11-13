const sequence=value=>Number.isSafeInteger(value)&&value>=0;
const identity=value=>typeof value==='string'&&value.length>0;

function resultCallId(message) {
  const sourceId=message?.source?.callId,toolId=message?.toolCallId;
  if(sourceId!==undefined&&!identity(sourceId)||toolId!==undefined&&!identity(toolId))return undefined;
  if(sourceId!==undefined&&toolId!==undefined&&sourceId!==toolId)return undefined;
  return sourceId??toolId;
}

/** Index recorded provenance only. A result link means a result exists, never
 * that the command, the displayed artifact, or the user's task succeeded.
 * Every record and relationship is scoped strictly before beforeSeq, so a
 * later result cannot change what was visible before a human intervention.
 */
export function createProvenanceIndex(entries,{beforeSeq=Infinity}={}) {
  if(beforeSeq!==Infinity&&!sequence(beforeSeq))throw new RangeError('beforeSeq must be a nonnegative sequence or Infinity');
  const visible=entries.filter(e=>sequence(e.seq)&&e.seq<beforeSeq).toSorted((a,b)=>a.seq-b.seq);
  const index=new Map(),calls=new Map();
  for(const entry of visible){
    const event=entry.source??{},data=event.data??{},message=data.message;
    const sourceKind=(data.source??message?.source)?.kind,record={};
    if(typeof sourceKind==='string'&&sourceKind)record.sourceKind=sourceKind;
    if(sequence(data.turn))record.turn=data.turn;
    if(Array.isArray(event.sourceEventSeqs))record.sourceEventSeqs=event.sourceEventSeqs.filter(seq=>sequence(seq)&&seq<entry.seq&&seq<beforeSeq);
    const replacement=event.surfaceOp;
    if(replacement?.op==='replace'&&sequence(replacement.startSeq)&&sequence(replacement.endSeq)
      &&replacement.startSeq<=replacement.endSeq&&replacement.endSeq<entry.seq&&replacement.endSeq<beforeSeq){
      record.replaces={startSeq:replacement.startSeq,endSeq:replacement.endSeq};
    }
    index.set(entry.seq,record);
    if(entry.type==='tool/call'&&identity(data.callId)){
      // Keep ambiguity once two prior calls have used the same native ID.
      calls.set(data.callId,calls.has(data.callId)?null:entry.seq);
    }else if(entry.type==='tool/result'){
      const id=resultCallId(message),callSeq=identity(id)?calls.get(id):undefined;
      if(callSeq!==undefined&&callSeq!==null&&callSeq<entry.seq){
        record.callSeq=callSeq;
        const call=index.get(callSeq);
        (call.resultSeqs??=[]).push(entry.seq);
      }
    }
  }
  return index;
}
