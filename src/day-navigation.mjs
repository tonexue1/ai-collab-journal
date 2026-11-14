import { interactionCalendar } from './days.mjs';

function civilDate(date){
  interactionCalendar({date,timeZone:'UTC'});
  return new Date(`${date}T12:00:00Z`);
}
export function todayInZone(timeZone,now=Date.now()){
  return interactionCalendar({timeZone}).day(now);
}
export function shiftDay(date,offset){
  const next=civilDate(date);
  next.setUTCDate(next.getUTCDate()+offset);
  return next.toISOString().slice(0,10);
}
export function canSelectDay(date,today){
  try {civilDate(date);return date<=today;}catch{return false;}
}
export function shiftMonth(month,offset){
  const next=civilDate(`${month}-01`);
  next.setUTCMonth(next.getUTCMonth()+offset);
  return next.toISOString().slice(0,7);
}
export function monthCells(month){
  const first=civilDate(`${month}-01`),next=civilDate(`${shiftMonth(month,1)}-01`);
  const days=(next-first)/86400000,cells=Array(first.getUTCDay()).fill(null);
  for(let n=1;n<=days;n++)cells.push(`${month}-${String(n).padStart(2,'0')}`);
  while(cells.length%7)cells.push(null);
  return cells;
}
export function filterDayGroups(days,date,query=''){
  const needle=query.toLowerCase();
  return days.filter(day=>day.date===date).map(day=>({...day,sessions:day.sessions.filter(session=>session.title.toLowerCase().includes(needle))})).filter(day=>day.sessions.length);
}
