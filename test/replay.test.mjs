import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../source-server.mjs';
import { ArchiveEngine } from '../src/engine.mjs';
import { fetchAllRecords } from '../src/client.mjs';
import { createService } from '../src/service.mjs';

test('扫描、调阅与补扫全流程回放', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  const engine = new ArchiveEngine();
  const poll = async () => engine.ingest((await fetchAllRecords(url)).records);
  const advance = async (stage) => {
    const response = await fetch(`${url}/control?stage=${stage}`, { method: 'POST' });
    assert.equal(response.status, 200);
    await poll();
    assert.equal(engine.stage, stage);
  };
  const complete = (v, e) => engine.completeness.get(`${v}@${e}`).complete;
  const missingFaces = (v, e, physical) =>
    engine.completeness.get(`${v}@${e}`).leaves.find((l) => l.physical === physical).missing;

  await t.test('阶段 1：双面批次确认出纸，页签不清的背面按结构暂定归属', async () => {
    await advance(1);
    const i19 = engine.images.get('I19');
    assert.equal(i19.physical, 'P61');
    assert.equal(i19.tentative, true); // 仅双面对应，待核
    assert.equal(i19.confirmed, true); // 卡纸边界前确认出纸
    assert.equal(complete('BN-7', 'E1'), true); // 暂时齐备
    assert.equal(complete('BN-8', 'E1'), false); // P63 尚无影像
    assert.deepEqual(missingFaces('BN-8', 'E1', 'P63'), ['front', 'back']);
  });

  await t.test('阶段 2：电子页按批次交付，整组模式等待齐备', async () => {
    await advance(2);
    assert.equal(engine.current.get('P61|front').imageId, 'I24'); // 拍清同面，取最新
    const b82 = engine.batchView('B82');
    assert.equal(b82.items.find((i) => i.physical === 'P61').status, '已交付');
    assert.equal(b82.items.find((i) => i.physical === 'P62').status, '已交付'); // blank 只需正面
    const b81 = engine.batchView('B81');
    assert.equal(b81.status, '整组等待'); // together：P63 背面未扫
    assert.deepEqual(b81.items.find((i) => i.physical === 'P63').missing, ['back']);
    const d = engine.deliveries.find((x) => x.batch === 'B82' && x.physical === 'P61');
    assert.deepEqual(d.faces, { front: 'I24', back: 'I19' }); // 当时依据保留
    assert.equal(engine.whereabouts.get('P61').status, '借出中');
    assert.equal(engine.whereabouts.get('P61').desk, '甲席');
  });

  await t.test('阶段 3：复核改属别卷，已交付版本保留并指明待核', async () => {
    await advance(3);
    const i19 = engine.images.get('I19');
    assert.equal(i19.physical, 'P62'); // 复核更正
    assert.equal(i19.corrected, true);
    assert.equal(engine.current.get('P62|back').imageId, 'I26'); // 补扫取代
    assert.equal(engine.current.get('P61|back'), undefined); // 缺口出现
    assert.deepEqual(missingFaces('BN-7', 'E1', 'P61'), ['back']);
    // 旧交付不作废抹除，只标记
    const d = engine.deliveries.find((x) => x.batch === 'B82' && x.physical === 'P61');
    assert.match(d.invalidated.reason, /I19.*P62/);
    assert.deepEqual(d.faces, { front: 'I24', back: 'I19' });
    // 指明由谁核对哪张纸
    const verify = engine.pendingVerifications.find((v) => v.loan === 'R1');
    assert.equal(verify.desk, '甲席');
    assert.equal(verify.physical, 'P61');
    // 在借原纸不排程
    const need = engine.plan.unscheduled.find((u) => u.physical === 'P61' && u.face === 'back');
    assert.match(need.reason, /在借/);
    // P63 背面缺口由已接单的 V92 覆盖
    const covered = engine.plan.covered.find((c) => c.physical === 'P63');
    assert.equal(covered.visit, 'V92');
    // 缺图与卡纸漏扫留待核，不塞进任何一卷
    assert.ok(engine.ambiguities().some((a) => a.type === '缺图待核' && a.job === 'F7' && a.position === 2));
    assert.ok(engine.feedNotes.some((n) => n.type === '背面未扫' && n.physical === 'P61'));
  });

  await t.test('阶段 4：换页新版独立齐备；取消请求不释放趟次；归还待核不排程', async () => {
    await advance(4);
    assert.equal(complete('BN-7', 'E2'), true); // P68 正面 + P62 双面
    assert.equal(engine.current.get('P63|back').imageId, 'I29');
    assert.equal(complete('BN-8', 'E1'), false); // 仍缺 P61 背面
    // V92 取消请求已登记但未确认释放，趟次仍被占
    const v92 = engine.plan.visits.find((v) => v.visit === 'V92');
    assert.equal(v92.bookedFaces, 1);
    assert.equal(v92.bookings[0].cancelRequestedAt, '11:34');
    // P61 已还待核：去向未核实，保留缺口
    assert.equal(engine.whereabouts.get('P61').status, '归还待核实');
    const need = engine.plan.unscheduled.find((u) => u.physical === 'P61' && u.face === 'back');
    assert.match(need.reason, /归还待/);
    // B81 无法按时齐备
    assert.ok(engine.batchView('B81').flags.some((f) => f.includes('无法按时')));
  });

  await t.test('阶段 5：接收点确认释放后原纸才可重新安排', async () => {
    await advance(5);
    const wb = engine.whereabouts.get('P61');
    assert.equal(wb.free, true);
    assert.equal(wb.location, '北柜');
    assert.equal(wb.since, '11:54');
    // V93 排程 P61 背面，一次扫描同时服务两个批次
    const assignment = engine.plan.assignments.find((a) => a.physical === 'P61' && a.face === 'back');
    assert.equal(assignment.visit, 'V93');
    assert.deepEqual(assignment.onTime.map((c) => c.batch).sort(), ['B82', 'B83']);
    assert.deepEqual(assignment.late.map((c) => c.batch), ['B81']); // 已过 11:42
    // V92 确认释放后不再占用
    assert.equal(engine.plan.visits.find((v) => v.visit === 'V92').bookedFaces, 0);
  });

  await t.test('调卷人员可按卷、接收点、实体纸追溯来源与流转依据', async () => {
    const volume = engine.volumeView('BN-7');
    assert.deepEqual(volume.editions.map((e) => e.edition), ['E1', 'E2']);
    const desk = engine.deskView('甲席');
    assert.equal(desk.loans[0].received[0].issue.includes('I19'), true); // 签收影像已改属
    assert.equal(desk.disputes[0].imageId, 'I19');
    const p61 = engine.physicalView('P61');
    assert.deepEqual(p61.timeline.map((e) => e.type), ['custody', 'received', 'returned', 'release']);
    assert.ok(p61.images.some((i) => i.imageId === 'I19' && i.corrected)); // 曾误归的影像可追溯
    assert.equal(engine.physicalView('P99'), null);
  });
});

test('查询服务对外提供批次、缺口、排程与追溯接口', async (t) => {
  const source = await start();
  t.after(() => new Promise((resolve, reject) => source.server.close((e) => (e ? reject(e) : resolve()))));
  await fetch(`${source.url}/control?stage=5`, { method: 'POST' });

  const service = createService({ source: source.url, intervalMs: 0 });
  const { url } = await service.start({ port: 0 });
  t.after(() => service.stop());

  const get = async (path) => {
    const response = await fetch(`${url}${path}`);
    return { status: response.status, body: await response.json() };
  };
  const root = await get('/');
  assert.equal(root.body.stage, 5);
  assert.equal(root.body.batches, 3);

  const gaps = await get('/gaps');
  const p61Gap = gaps.body.gaps.find((g) => g.physical === 'P61' && g.face === 'back');
  assert.equal(p61Gap.state, '已排程');
  assert.equal(p61Gap.consumers.length, 3);

  const b81 = await get('/batches/B81');
  assert.equal(b81.body.status, '整组等待');
  assert.ok(b81.body.flags.some((f) => f.includes('无法按时')));

  const desk = await get(`/desks/${encodeURIComponent('甲席')}`);
  assert.equal(desk.body.pendingVerifications[0].physical, 'P61');

  const schedule = await get('/schedule');
  assert.ok(schedule.body.assignments.some((a) => a.visit === 'V93'));

  const deliveries = await get('/deliveries');
  assert.ok(deliveries.body.some((d) => d.invalidated)); // 旧交付按当时依据回查

  assert.equal((await get('/volumes/BN-9')).status, 404);
  assert.equal((await get('/physicals/P99')).status, 404);
});
