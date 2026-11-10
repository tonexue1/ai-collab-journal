import assert from 'node:assert/strict';
import path from 'node:path';
export async function testTrajectories({page,store,engine,screenshots}){
  await page.locator('.workspace-tile').first().waitFor();assert.equal(await page.locator('.workspace-tile').count(),3);
  await page.locator('[data-workspace="demo/harmony-push"]').click();assert.equal(await page.locator('.conversation-item').count(),1);
  await page.getByRole('tab',{name:'完整原文',exact:true}).click();await page.locator('.trajectory-original .message').first().waitFor();
  assert.equal(store.runs().filter(r=>r.kind==='trajectory').length,0);
  await page.getByRole('tab',{name:'协作轨迹',exact:true}).click();await page.locator('#parse-trajectory').click();
  await page.locator('.timeline-entry').first().waitFor();assert.equal(await page.locator('.timeline-entry').count(),12);
  await page.screenshot({path:path.join(screenshots,'trajectory-desktop.png')});
  await page.locator('[data-node-source]').first().click();await page.locator('.node-source .message.evidence').first().waitFor();
  const parsed=store.trajectory('demo-session-1');assert(parsed);
  await page.reload();await page.locator('[data-workspace="demo/harmony-push"]').click();await page.locator('.timeline-entry').first().waitFor();
  const updated=store.messages('demo-session-1');updated[0].parts[0].text='改动后的原文';store.upsertSession(store.sessions().find(s=>s.id==='demo-session-1'),updated);
  await page.reload();await page.locator('[data-workspace="demo/harmony-push"]').click();await page.getByText('会话内容已变化。当前轨迹和节点原文保留上次解析时的快照，重新解析可更新。',{exact:true}).waitFor();
  await page.locator('[data-node-source]').first().click();await page.locator('.node-source .message.evidence').first().waitFor();assert.match(await page.locator('.node-source .message.evidence').first().textContent(),/先了解这项任务的现状/);
  const oldAnalyze=engine.adapter.analyze.bind(engine.adapter);engine.adapter.analyze=async()=>{throw Object.assign(new Error('测试模型不可用'),{scope:'global'})};
  await page.locator('#parse-trajectory').click();await page.getByText(/上次解析失败：测试模型不可用/).waitFor();assert.equal(await page.locator('.timeline-entry').count(),12);engine.adapter.analyze=oldAnalyze;
  await page.locator('#parse-trajectory').click();await page.getByText('改动后的原文',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'trajectory mobile overflow');
  await page.screenshot({path:path.join(screenshots,'trajectory-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
  await page.locator('#conversation-search').fill('没有这个会话');await page.getByText('没有匹配的会话',{exact:true}).waitFor();
  assert.equal(await page.locator('#parse-trajectory').count(),0);
  await page.locator('#conversation-search').fill('');await page.locator('.conversation-item').first().click();
  // A delayed response for another session must never overwrite the current one.
  await page.locator('[data-workspace="*"]').click();let finish,entered;const received=new Promise(r=>entered=r);
  await page.route('**/api/trajectories/demo-session-0',async route=>{const response=await route.fetch();entered();await new Promise(r=>finish=r);await route.fulfill({response});});
  await page.locator('[data-conversation="demo-session-0"]').click();await received;
  await page.locator('[data-conversation="demo-session-1"]').click();await page.locator('.timeline-entry').first().waitFor();finish();
  await page.unroute('**/api/trajectories/demo-session-0');assert.match(await page.locator('.trajectory-detail-head h2').textContent(),/跨端对照/);
  console.log('PASS workspace grouping, manual parse, snapshot, retry, reload, search, race and mobile trajectory');
}
