const isReplacement=entry=>entry.source?.surfaceOp?.op==='replace';

/** Derive reading boundaries only; no classification or outcome inference.
 * Consecutive human expressions retain separate anchors but share the latest
 * AI process and the chain of human requests that preceded that process.
 */
export function indexInteractions(entries){
  const humans=[],tools=[0];
  for(let i=0;i<entries.length;i++){
    if(entries[i].role==='user')humans.push(i);
    tools.push(tools.at(-1)+(entries[i].type==='tool/call'?1:0));
  }
  const range=(start,end)=>({
    fromSeq:end>start?entries[start].seq:null,toSeq:end>start?entries[end-1].seq:null,
    entryCount:end-start,toolCount:tools[end]-tools[start],
  });
  const items=[];
  let requestStart=null,precedingRequestStart=0,actionSinceHuman=false,preview=null;
  for(let i=0;i<entries.length;i++){
    const entry=entries[i];
    if(entry.role==='user'){
      const next=humans[items.length+1]??entries.length;
      items.push({id:`h${entry.seq}`,human:{seq:entry.seq,time:entry.time,type:entry.type,text:entry.text},
        before:{...range(precedingRequestStart,i),preview:preview?{...preview}:null},
        after:range(i+1,next),isFirst:items.length===0});
      if(requestStart===null||actionSinceHuman)requestStart=i;
      actionSinceHuman=false;
    }else if(entry.role==='assistant'&&!isReplacement(entry)){
      precedingRequestStart=requestStart??0;actionSinceHuman=true;
      if(preview&&preview.seq<entries[precedingRequestStart].seq)preview=null;
      if(entry.type==='assistant/message')preview={seq:entry.seq,time:entry.time,text:entry.text};
    }
  }
  return items;
}
