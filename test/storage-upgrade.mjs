import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { journalSpec } from '../src/domain.mjs';

// Exercise the declaring schema against the selected DSH's real JSON backend.
// A version bump or incompatible report schema must not strand existing data.
export async function verifyStorageUpgrade(spec=journalSpec) {
  const require=createRequire(resolve(process.env.DSH_CLI||'.dsh-test/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'));
  const load=name=>import(pathToFileURL(require.resolve(name)));
  const [{Context},{Storage},{JsonStorageBackend},{DomainFacility}]=await Promise.all([
    load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-storage'),
    load('@deepseek-ai/dsh-storage-json'),load('@deepseek-ai/dsh-storage-domain'),
  ]);
  const root=await mkdtemp(join(tmpdir(),'journal-storage-upgrade-'));
  const path=join(root,'dsh_collab_journal.json');
  const report={sessionId:'legacy-session',snapshotId:'legacy-fingerprint',generatedAt:100,
    route:{provider:'fixture',model:'old-model'},
    nodes:[{id:'n1',role:'user',seqs:[1],startedAt:10,endedAt:10,toolCount:0,summary:'原有表达',details:[]}],
    entries:[{seq:1,time:10,type:'user/message',role:'user',text:'原有原文',source:{seq:1,type:'user/message'}}]};
  const versionKey='legacy-session.legacy-fingerprint';
  await writeFile(path,JSON.stringify({unit:{name:'dsh_collab_journal',version:1},global:null,
    tables:{reports:{'legacy-session':report},versions:{[versionKey]:report}}}));
  const checkpoint={sessionId:'legacy-session',jobId:'checkpoint-job',snapshotId:'legacy-fingerprint',
    route:{provider:'fixture',model:'old-model'},analysisVersion:'test-version',updatedAt:200,
    cache:{'completed-batch':[{id:'n1.1.0',summary:'已保存的分片摘要',details:['仍可继续解析']} ]}};
  let domain,backend;
  async function open(){
    const ctx=new Context();new Storage(ctx);
    backend=new JsonStorageBackend(root);ctx.storage.backend.register('json',backend);
    domain=await new DomainFacility(ctx,{backend:'json'}).open(spec);
  }
  async function close(){await domain?.close();await backend?.close();domain=null;backend=null;}
  function oldDataSurvives(){
    assert.deepEqual(domain.table('reports').get('legacy-session'),report);
    assert.deepEqual(domain.table('versions').get(versionKey),report);
  }
  try {
    await open();oldDataSurvives();
    assert.equal(domain.table('checkpoints').size,0,'an old v1 document has no checkpoint table yet');
    await domain.table('checkpoints').put('legacy-session',checkpoint);
    await close();
    await open();oldDataSurvives();
    assert.deepEqual(domain.table('checkpoints').get('legacy-session'),checkpoint);
    assert.equal(await domain.table('checkpoints').delete('legacy-session'),true);
    await close();
    await open();oldDataSurvives();
    assert.equal(domain.table('checkpoints').get('legacy-session'),undefined);
    const persisted=JSON.parse(await readFile(path,'utf8'));
    assert.equal(persisted.unit.version,1);
    assert.deepEqual(persisted.tables.reports,{'legacy-session':report});
    assert.deepEqual(persisted.tables.versions,{[versionKey]:report});
    console.log('Existing v1 reports and original snapshots survive checkpoint writes, reopen and deletion.');
  } finally {await close();await rm(root,{recursive:true,force:true});}
}
