/** Calendar navigation never changes the native event order or context bounds. */
export function interactionCalendar({timeZone,date}={}){
  if(timeZone!==undefined&&(typeof timeZone!=='string'||!timeZone))throw new RangeError('无效的时区');
  let formatter;
  try {formatter=new Intl.DateTimeFormat('en',{timeZone:timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit'});}
  catch {throw new RangeError('无效的时区');}
  if(date!==undefined&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(`${date}T00:00:00Z`))||new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date))throw new RangeError('无效的日期');
  return {timeZone:formatter.resolvedOptions().timeZone,date,
    day(time){
      if(typeof time!=='number'||!Number.isFinite(time)||!Number.isFinite(new Date(time).valueOf()))return null;
      const parts=Object.fromEntries(formatter.formatToParts(time).map(p=>[p.type,p.value]));
      return `${parts.year.padStart(4,'0')}-${parts.month}-${parts.day}`;
    },
  };
}
