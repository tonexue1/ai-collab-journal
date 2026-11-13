import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCatalogDetail } from '../src/catalog-sync.mjs';

function catalog() {
  return {pluginBuild:{version:'test',id:'build'},workspaces:[
    {id:'a',title:'A',sessions:[{id:'short',title:'Short',status:'stale',humanCount:2,archived:true,lastActivityAt:100}]},
    {id:'b',title:'B',sessions:[{id:'other',title:'Other',status:'unparsed',humanCount:1}]},
  ]};
}

test('reopening a parse completed while away synchronizes its row without replacing other sessions',()=>{
  const before=catalog();
  const after=syncCatalogDetail(before,{id:'short',humanCount:3,report:{stale:false},run:{status:'completed'}});
  assert.deepEqual(after.workspaces[0].sessions[0],{id:'short',title:'Short',status:'ready',humanCount:3,archived:true,lastActivityAt:100});
  assert.equal(before.workspaces[0].sessions[0].status,'stale');
  assert.equal(after.workspaces[1],before.workspaces[1]);
  assert.equal(after.pluginBuild,before.pluginBuild);
});

test('a first parse completed while away contributes to the parsed overview',()=>{
  const before=catalog();
  const after=syncCatalogDetail(before,{id:'other',humanCount:1,report:{stale:false},run:{status:'completed'}});
  assert.equal(after.workspaces.flatMap(w=>w.sessions).filter(s=>s.status==='ready'||s.status==='stale').length,2);
});

test('failed reruns derive status from the preserved report, including newly appended content',()=>{
  for(const [stale,status] of [[true,'stale'],[false,'ready']]) {
    const after=syncCatalogDetail(catalog(),{id:'short',humanCount:3,report:{stale},run:{status:'failed'}});
    assert.equal(after.workspaces[0].sessions[0].status,status);
  }
  const after=syncCatalogDetail(catalog(),{id:'short',humanCount:3,report:null,run:{status:'failed'}});
  assert.equal(after.workspaces[0].sessions[0].status,'unparsed');
});

test('successful detail reads clear only that row’s obsolete read error',()=>{
  const before=catalog();Object.assign(before.workspaces[0].sessions[0],{status:'error',error:'old read failure'});
  const after=syncCatalogDetail(before,{id:'short',humanCount:2,report:null,run:null});
  assert.equal(after.workspaces[0].sessions[0].status,'unparsed');
  assert.equal('error' in after.workspaces[0].sessions[0],false);
});

test('unchanged or missing detail preserves catalog identity to avoid update loops',()=>{
  const before=catalog();
  assert.equal(syncCatalogDetail(before,{id:'short',humanCount:2,report:{stale:true},run:null}),before);
  assert.equal(syncCatalogDetail(before,{id:'absent',humanCount:1,report:null}),before);
  assert.equal(syncCatalogDetail(before,null),before);
  assert.equal(syncCatalogDetail(null,{id:'short',humanCount:2,report:null}),null);
});

test('a running parse keeps the old snapshot status and does not count unfinished work as parsed',()=>{
  const before=catalog();
  const oldReport={stale:true,snapshotId:'old',nodes:[{id:'n1',summary:'previous result'}]};
  const detail={id:'short',humanCount:3,report:oldReport,run:{status:'running'}};
  const after=syncCatalogDetail(before,detail);
  assert.equal(after.workspaces[0].sessions[0].status,'stale');
  assert.equal(detail.report,oldReport);
  assert.deepEqual(oldReport,{stale:true,snapshotId:'old',nodes:[{id:'n1',summary:'previous result'}]});
  const unfinished=syncCatalogDetail(after,{id:'other',humanCount:1,report:null,run:{status:'running'}});
  assert.equal(unfinished.workspaces[1].sessions[0].status,'unparsed');
  assert.equal(syncCatalogDetail(after,detail),after);
});
