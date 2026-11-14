import test from 'node:test';
import assert from 'node:assert/strict';
import * as navigation from '../src/day-navigation.mjs';

test('previous and next day cross leap days and years without depending on elapsed DST hours',()=>{
  assert.equal(typeof navigation.shiftDay,'function');
  for(const [date,offset,want] of [
    ['2024-03-01',-1,'2024-02-29'],['2023-03-01',-1,'2023-02-28'],
    ['2026-12-31',1,'2027-01-01'],['2026-01-01',-1,'2025-12-31'],
    ['2026-03-08',1,'2026-03-09'],['2026-11-01',-1,'2026-10-31'],
  ])assert.equal(navigation.shiftDay(date,offset),want);
  assert.throws(()=>navigation.shiftDay('2026-02-30',1),RangeError);
});

test('today follows the displayed timezone and future calendar dates cannot be selected',()=>{
  assert.equal(typeof navigation.todayInZone,'function');
  const now=Date.parse('2026-11-13T16:01:00Z');
  assert.equal(navigation.todayInZone('Asia/Shanghai',now),'2026-11-14');
  assert.equal(navigation.todayInZone('America/New_York',now),'2026-11-13');
  assert.equal(navigation.canSelectDay('2026-11-14','2026-11-14'),true);
  assert.equal(navigation.canSelectDay('2026-11-15','2026-11-14'),false);
  assert.equal(navigation.canSelectDay('2026-02-30','2026-11-14'),false);
});

test('month picker positions every real date in the right weekday and crosses the year boundary',()=>{
  assert.equal(typeof navigation.monthCells,'function');
  const cells=navigation.monthCells('2024-03');
  assert.equal(cells.length,42);
  assert.deepEqual(cells.slice(0,7),[null,null,null,null,null,'2024-03-01','2024-03-02']);
  assert.equal(cells[35],'2024-03-31');
  assert.deepEqual(cells.slice(36),[null,null,null,null,null,null]);
  assert.equal(navigation.shiftMonth('2026-12',1),'2027-01');
  assert.equal(navigation.shiftMonth('2026-01',-1),'2025-12');
});

test('an empty selected day stays empty instead of falling back to a different day or matching session',()=>{
  assert.equal(typeof navigation.filterDayGroups,'function');
  const days=[
    {date:'2026-11-14',sessions:[{id:'a',title:'Alpha'},{id:'b',title:'Beta'}]},
    {date:'2026-11-13',sessions:[{id:'a',title:'Alpha yesterday'}]},
  ];
  assert.deepEqual(navigation.filterDayGroups(days,'2026-11-12','Alpha'),[]);
  assert.deepEqual(navigation.filterDayGroups(days,'2026-11-14','YESTERDAY'),[]);
  assert.deepEqual(navigation.filterDayGroups(days,'2026-11-13','ALPHA'),[{date:'2026-11-13',sessions:[{id:'a',title:'Alpha yesterday'}]}]);
  assert.equal(days[0].sessions.length,2,'filtering must not mutate catalog state');
});
