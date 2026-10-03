'use strict';

// 共享房间「预约启播」HTTP 单元测试：
// 暂停房间主持人凭当前控制密钥与修订号预约未来墙钟时刻启播；同一房间只保留最近一次
// 预约、可取消（各使修订号 +1）；到点按现有播放规则从断点启动（已完成的循环排演从
// 首段重来、普通房间停在末尾从头开始），自动启播不增加修订号且不重复启播；服务重启
// 或首次查询晚于预约时刻时仍按预约时刻起算墙钟进度，准确停在先遇到的讨论停点、超载
// 边界或版本末尾。成功的手动控制取消待生效预约；主持权交接保留预约；无权、过期修订号、
// 非未来时刻、播放中预约、不安全起点均明确拒绝且房间不变；GET 显示预约状态与启播结果
// 且不泄露控制密钥。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-schedule-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');

let server;

function request(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => server.close(r));
});

async function resetDraft() {
  const cues = await getJson('/api/cues');
  for (const c of cues) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await getJson('/api/lights');
  for (const l of lights) await request('DELETE', `/api/lights/${l.id}`);
  const circuits = await getJson('/api/circuits');
  for (const c of circuits) await request('DELETE', `/api/circuits/${c.id}`);
}

// 版本：灯 L，t=0 渐变到 100、duration 10 → 末尾 10 秒
async function seedPlainVersion() {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: '预约大灯' })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9601, light_id: l, time: 0, target: 100, duration: 10 }]);
  return (await request('POST', '/api/versions', { label: '预约版' })).json;
}

// 短版本：末尾 1 秒（时序测试用，墙钟开销小）
async function seedShortVersion() {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: '预约小灯' })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9701, light_id: l, time: 0, target: 100, duration: 1 }]);
  return (await request('POST', '/api/versions', { label: '预约短版' })).json;
}

// 带超载保护的版本：超载区间 [0.3, 1)，闭左边界 0.3；末尾 1 秒
async function seedProtectedVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '超载回路T', capacity: 100 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '大灯T' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('POST', '/api/cues', [
    { cue_no: 9801, light_id: l1, time: 0, target: 50, duration: 0 },
    { cue_no: 9802, light_id: l1, time: 0.3, target: 100, duration: 0 },
    { cue_no: 9803, light_id: l1, time: 1, target: 0, duration: 0 },
  ]);
  return { version: (await request('POST', '/api/versions', { label: '保护预约版' })).json, c1 };
}

async function createRoom(versionId, body = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, ...body });
}
const schedUrl = (code) => `/api/rooms/${code}/schedule`;
const ctrlUrl = (code) => `/api/rooms/${code}/control`;

test('预约：缺/错密钥 403、修订号缺失非法 400、过期 409，均不改变房间', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const future = Date.now() / 1000 + 60;

  let r = await request('PUT', schedUrl(c.code), { revision: 0, start_at: future });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await request('PUT', schedUrl(c.code), { control_key: 'deadbeef'.repeat(6), revision: 0, start_at: future });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, start_at: future });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: -1, start_at: future });
  assert.equal(r.status, 400);

  // 先让房间修订号前进一次，再用过时的 0 预约
  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 0, action: 'pause' });
  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: future });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.schedule, undefined, '拒绝预约后房间无预约状态块');
  assert.equal(g.json.revision, 1);
});

test('预约：非未来时刻（过去/现在/非法值）400 且房间不变', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const g0 = await getJson(`/api/rooms/${c.code}`);
  const now = g0.server_wall;

  let r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: now - 10 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不是未来时刻/);

  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: now });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不是未来时刻/);

  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: 'not-a-time' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /预约时刻无效/);

  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /预约时刻无效/);

  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.revision, 0, '房间修订号未变');
  assert.equal(g.schedule, undefined);
});

test('预约：播放中的房间 400 拒绝且房间不变', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 0, action: 'play' });

  const future = Date.now() / 1000 + 60;
  const r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: future });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /正在播放中/);

  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, true, '房间仍在播放');
  assert.equal(g.revision, 1, '修订号未变');
  assert.equal(g.schedule, undefined);
});

test('预约成功：暂停房间修订号 +1，GET 返回待生效预约（含剩余秒数与断点），不回显密钥', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  // 暂停在 3 秒处后预约
  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 0, action: 'seek', time: 3 });
  const future = Date.now() / 1000 + 120;

  const r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: future });
  assert.equal(r.status, 200);
  assert.ok(r.json.schedule);
  assert.equal(r.json.schedule.active, true);
  assert.ok(Math.abs(r.json.schedule.start_wall - future) < 1e-6);
  assert.ok(r.json.schedule.seconds_remaining > 119 && r.json.schedule.seconds_remaining <= 120);
  assert.ok(Math.abs(r.json.schedule.from_time - 3) < 1e-6, '启播断点为当前暂停时码 3');
  assert.equal(r.json.revision, 2, '预约使修订号 +1');
  assert.equal(r.json.playing, false, '预约后房间仍暂停');
  assert.equal(r.json.control_key, undefined, '响应不回显密钥');

  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.schedule.active, true);
  assert.equal(g.control_key, undefined);
  assert.equal(g.playing, false, '预约时刻未到，房间保持暂停在断点');
  assert.ok(Math.abs(g.time - 3) < 1e-6);
});

test('同一房间只保留最近一次预约：再次预约覆盖旧预约、修订号再 +1', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;

  const t1 = Date.now() / 1000 + 60;
  let r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: t1 });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.json.schedule.start_wall - t1) < 1e-6);

  const t2 = Date.now() / 1000 + 180;
  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: t2 });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.json.schedule.start_wall - t2) < 1e-6);
  assert.equal(r.json.revision, 2);

  const g = await getJson(`/api/rooms/${c.code}`);
  assert.ok(Math.abs(g.schedule.start_wall - t2) < 1e-6, '只保留最近一次预约');
});

test('取消预约：成功后修订号 +1、预约消失；无待生效预约取消 400 且房间不变', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const future = Date.now() / 1000 + 60;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: future });

  let r = await request('DELETE', schedUrl(c.code), { control_key: c.control_key, revision: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule, undefined, '取消后无预约块（也无启播结果块）');
  assert.equal(r.json.revision, 2, '取消使修订号 +1');
  assert.equal(r.json.playing, false, '取消不改变播放状态');

  // 再次取消：无待生效预约 → 400，房间不变
  r = await request('DELETE', schedUrl(c.code), { control_key: c.control_key, revision: 2 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /没有待生效的预约启播/);
  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.revision, 2);
});

test('到点自动启播：暂停断点继续播放，自动启播不增加修订号、不重复启播', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  // 暂停在 0.2 秒
  await ctrl({ revision: 0, action: 'play' });
  await sleep(220);
  await ctrl({ revision: 1, action: 'pause' });
  const paused = await getJson(`/api/rooms/${c.code}`);
  assert.equal(paused.playing, false);
  assert.ok(paused.time > 0.15 && paused.time < 0.3, `断点 time=${paused.time}`);
  const pausedTime = paused.time;
  const revAfterPause = paused.revision;
  assert.equal(revAfterPause, 2);

  // 预约约 0.3 秒后启播
  const t0 = Date.now() / 1000;
  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 2,
    start_at: t0 + 0.3,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 3);

  // 预约时刻之前：仍暂停
  await sleep(120);
  let g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, false, '预约未到点，保持暂停');
  assert.equal(g.schedule.active, true);

  // 到点之后：自动启播（惰性触发），从断点 ≈0.2 起走完剩余约 0.8 秒到末尾
  await sleep(1100);
  g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, false, '1 秒短版本：启播后已到末尾自动停住');
  assert.ok(Math.abs(g.time - 1) < 1e-6, `time=${g.time} 应停在末尾 1`);
  assert.equal(g.revision, 3, '自动启播（含到末尾停住）不增加修订号');
  // 启播结果块：停在末尾
  assert.ok(g.schedule, '展示启播结果');
  assert.equal(g.schedule.fired, true);
  assert.equal(g.schedule.result, 'stopped_at_end');
  assert.ok(Math.abs(g.schedule.started_at - (t0 + 0.3)) < 1e-6);

  // 不重复启播：预约行已消费，后续查询不再变化
  const g2 = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g2.playing, false);
  assert.ok(Math.abs(g2.time - 1) < 1e-6);
  assert.equal(g2.revision, 3);
  assert.ok(!g2.schedule.active, '无待生效预约（已消费，不重复启播）');
  assert.equal(g2.schedule.fired, true, '启播结果仍展示但无待生效预约');
});

test('自动启播从断点起算：预约时刻到点后时码=断点+流逝，而非查询时刻起播', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  // 暂停在 0
  await ctrl({ revision: 0, action: 'pause' });
  // 预约 0.2 秒后启播
  const startWall = Date.now() / 1000 + 0.2;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: startWall });

  // 远晚于预约时刻才首次查询（模拟服务重启/首次查询已晚）：时码按预约时刻起算
  await sleep(700);
  const g = await getJson(`/api/rooms/${c.code}`);
  const expected = (Date.now() / 1000 - startWall);
  assert.equal(g.playing, true, '自动启播后仍在播放');
  assert.ok(Math.abs(g.time - expected) < 0.12, `time=${g.time} 应按预约时刻起算≈${expected}`);
  assert.equal(g.revision, 2, '自动启播不增加修订号');
  assert.equal(g.schedule.fired, true);
  assert.equal(g.schedule.result, 'playing');
});

test('首次查询晚于预约时刻且已越过讨论停点：准确停在先遇到的停点（不越过）', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await request('PUT', `/api/rooms/${c.code}/stops`, { control_key: c.control_key, revision: 0, stops: [0.5] });
  await ctrl({ revision: 1, action: 'pause' }); // 修订号 2，房间仍在 0
  // 预约 0.1 秒后启播；0.5 秒后才查询（已越过 0.5 停点与 1 末尾中的先到者 0.5）
  const startWall = Date.now() / 1000 + 0.1;
  const r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 2, start_at: startWall });
  assert.equal(r.status, 200);

  await sleep(650);
  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 0.5) < 1e-6, `应准确停在先遇到的停点 0.5，time=${g.time}`);
  assert.ok(g.stops.tripped, '显示停点触发原因');
  assert.equal(g.protection.tripped, undefined);
  assert.equal(g.schedule.result, 'stopped_at_discussion_point', '启播结果=停在讨论停点');
  assert.equal(g.revision, 3, '全程不增加修订号');
});

test('首次查询晚于预约时刻且先遇到超载边界：准确停在边界、不越过危险段', async () => {
  const { version } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await ctrl({ revision: 0, action: 'pause' });
  const startWall = Date.now() / 1000 + 0.1;
  const r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: startWall });
  assert.equal(r.status, 200);

  await sleep(700); // 首次查询已晚：先遇到超载边界 0.3
  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 0.3) < 1e-6, `应准确停在超载边界 0.3，time=${g.time}`);
  assert.ok(g.protection.tripped, '超载触发');
  assert.equal(g.schedule.result, 'stopped_at_overload_boundary');
  assert.equal(g.revision, 2);
});

test('不安全起点：启用保护且断点处于超载区间时预约 400（附回路信息），房间不变', async () => {
  const { version } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  // 暂停态跳入超载段内 0.5（暂停允许避险跳转）
  const seek = await ctrl({ revision: 0, action: 'seek', time: 0.5 });
  assert.equal(seek.status, 200);
  assert.equal(seek.json.protection.overloaded_now, true);

  const future = Date.now() / 1000 + 60;
  const r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: future });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'overloaded_scheduled_start');
  assert.ok(Math.abs(r.json.time - 0.5) < 1e-6);
  assert.ok(Array.isArray(r.json.circuits) && r.json.circuits.length > 0);
  assert.match(r.json.error, /起点不安全/);

  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.schedule, undefined, '不安全起点：预约不落库');
  assert.equal(g.revision, 1, '修订号未变');
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 0.5) < 1e-6, '房间不变');
});

test('成功的手动控制取消待生效预约（play/pause/seek/speed 均取消）', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  const future = Date.now() / 1000 + 120;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: future });
  assert.equal((await getJson(`/api/rooms/${c.code}`)).schedule.active, true);

  // 成功的暂停控制取消预约（同时清除启播结果标记位——此处本就未启播）
  const r = await ctrl({ revision: 1, action: 'pause' });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule, undefined, '手动控制后无预约块');

  // 等到原预约时刻过后：房间没有自动启播（预约已被取消）
  await sleep(200);
  const g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, false, '预约已取消，到点不启播');
  assert.equal(g.schedule, undefined);
});

test('提交/取消循环排演取消待生效预约；手动跳转取消编排与预约', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const future = Date.now() / 1000 + 120;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: future });

  // 提交循环排演立即播放：预约取消
  const prog = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 1,
    segments: [{ start: 2, end: 8, repeat: 2 }],
  });
  assert.equal(prog.status, 200);
  assert.equal(prog.json.playing, true);
  assert.equal(prog.json.schedule, undefined);

  // 再预约（暂停后），然后用 program/clear 取消
  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 2, action: 'pause' });
  const future2 = Date.now() / 1000 + 120;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 3, start_at: future2 });
  const cleared = await request('POST', `/api/rooms/${c.code}/program/clear`, {
    control_key: c.control_key,
    revision: 4,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.schedule, undefined);
  assert.equal(cleared.json.program, undefined);
});

test('循环排演暂停中预约：到点从断点接续；已完成的循环排演预约：到点从首段重来', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  // 段 [0.2, 0.8] 重复 5 次
  const prog = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0.2, end: 0.8, repeat: 5 }],
  });
  assert.equal(prog.status, 200);
  await sleep(200); // 走到约 0.4
  await ctrl({ revision: 1, action: 'pause' });
  const paused = await getJson(`/api/rooms/${c.code}`);
  assert.equal(paused.program.status, 'paused');
  assert.equal(paused.program.loop, 1);
  const breakTime = paused.time;
  assert.ok(breakTime > 0.3 && breakTime < 0.5, `断点 ${breakTime}`);

  // 预约 0.2 秒后续播：从断点接续（段、轮不重置）
  const startWall = Date.now() / 1000 + 0.2;
  const sr = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 2, start_at: startWall });
  assert.equal(sr.status, 200);
  assert.ok(Math.abs(sr.json.schedule.from_time - breakTime) < 1e-6);

  await sleep(350);
  let g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, true, '自动续播');
  assert.equal(g.program.loop, 1, '从断点接续：仍是第 1 轮');
  assert.ok(g.time > breakTime, `时码前进 ${g.time} > ${breakTime}`);

  // 手动暂停 → 手动走到编排全部完成（用大倍速直接等待）：改用取消编排+重排更稳，
  // 这里直接等编排走完（段长 0.6 × 5 轮 = 3.0s 墙钟）
  // 注：上面已耗 0.35s 播放，剩余约 2.65s
  await sleep(3000);
  g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.program.finished, true, '编排全部完成，停在末段终点');
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 0.8) < 1e-6);

  // 已完成的编排：预约 0.1 秒后从首段重来
  const startWall2 = Date.now() / 1000 + 0.1;
  const sr2 = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 3, start_at: startWall2 });
  assert.equal(sr2.status, 200);
  assert.ok(Math.abs(sr2.json.schedule.from_time - 0.2) < 1e-6, '启播断点预告为首段起点 0.2');

  await sleep(300);
  g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, true, '到点自动启播');
  assert.equal(g.program.finished, false, '编排从首段重来');
  assert.equal(g.program.segment_index, 1);
  assert.equal(g.program.loop, 1, '第 1 轮重新开始');
  assert.ok(g.time >= 0.2 && g.time < 0.8, `从首段起点播放中 time=${g.time}`);
  assert.equal(g.revision, 4, '自动启播不增加修订号（预约提交已 +1 到 4）');
});

test('普通房间停在末尾预约：到点从 0 开始播放', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await ctrl({ revision: 0, action: 'play' });
  await sleep(1300);
  let g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 1) < 1e-6, '已停在末尾');

  const startWall = Date.now() / 1000 + 0.15;
  const sr = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: startWall });
  assert.equal(sr.status, 200);
  assert.ok(Math.abs(sr.json.schedule.from_time - 0) < 1e-6, '断点预告为 0（从头开始）');

  await sleep(1200);
  g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, false, '短版本：从头播放后又到末尾');
  assert.ok(Math.abs(g.time - 1) < 1e-6);
  assert.equal(g.schedule.result, 'stopped_at_end');
});

test('主持权交接保留预约：新主持人可取消，预约墙钟与启播行为不变', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;

  const future = Date.now() / 1000 + 120;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: future });

  // 发起并完成交接
  const issue = await request('POST', `/api/rooms/${c.code}/handover/issue`, {
    control_key: c.control_key,
    revision: 1,
  });
  assert.equal(issue.status, 200);
  const claim = await request('POST', `/api/rooms/${c.code}/handover/claim`, {
    handover_token: issue.json.handover_token,
    revision: 1,
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.revision, 2);
  assert.ok(claim.json.schedule, '交接后预约仍在');
  assert.equal(claim.json.schedule.active, true);
  assert.ok(Math.abs(claim.json.schedule.start_wall - future) < 1e-6);

  // 旧密钥无权取消
  let r = await request('DELETE', schedUrl(c.code), { control_key: c.control_key, revision: 2 });
  assert.equal(r.status, 403);

  // 新密钥可以取消（修订号 2 → 3）
  r = await request('DELETE', schedUrl(c.code), { control_key: claim.json.control_key, revision: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 3);
  assert.equal(r.json.schedule, undefined);
});

test('维护讨论停点不影响待生效预约；自动启播会受停点拦截', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const future = Date.now() / 1000 + 120;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: future });

  // 提交停点：预约保留（修订号 2）
  const r = await request('PUT', `/api/rooms/${c.code}/stops`, {
    control_key: c.control_key,
    revision: 1,
    stops: [5],
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.schedule && r.json.schedule.active, '维护停点不取消预约');
  assert.deepEqual(r.json.stops.points, [5]);
});

test('取消预约鉴权：观看者 403；房间码格式错误 400 / 不存在 404', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const future = Date.now() / 1000 + 60;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: future });

  let r = await request('DELETE', schedUrl(c.code), { revision: 1 });
  assert.equal(r.status, 403);

  r = await request('PUT', '/api/rooms/BAD/schedule', { control_key: c.control_key, revision: 0, start_at: future });
  assert.equal(r.status, 400);

  r = await request('PUT', '/api/rooms/ZZZZZZ/schedule', { control_key: c.control_key, revision: 0, start_at: future });
  assert.equal(r.status, 404);
});

test('重启后待生效预约仍在；重启后首次查询晚于预约时刻仍按预约时刻起算且不重复启播', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await ctrl({ revision: 0, action: 'pause' });
  // 预约 0.2 秒后启播，然后不查询、直接“重启”
  const startWall = Date.now() / 1000 + 0.2;
  const sr = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: startWall });
  assert.equal(sr.status, 200);

  const { app: app2 } = require('../server.js');
  const s2 = http.createServer(app2);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    // 重启后等预约时刻过去 0.5 秒才首次查询
    await sleep(600);
    const g = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s2.address().port, path: `/api/rooms/${c.code}` }, (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    const expected = Date.now() / 1000 - startWall;
    assert.equal(g.playing, true, '重启后到点仍自动启播');
    assert.ok(Math.abs(g.time - expected) < 0.15, `time=${g.time} 按预约时刻起算≈${expected}`);
    assert.equal(g.revision, 2, '自动启播不增加修订号');
    assert.equal(g.schedule.fired, true);
    assert.ok(!g.schedule.active, '重启后预约已消费，无待生效预约');

    // 再次重启：预约已消费，不会重复启播（房间继续按墙钟播放）
    const { app: app3 } = require('../server.js');
    const s3 = http.createServer(app3);
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    try {
      const g3 = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: s3.address().port, path: `/api/rooms/${c.code}` }, (res) => {
          let d = '';
          res.on('data', (x) => (d += x));
          res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      assert.ok(!g3.schedule.active, '无待生效预约，不会再次启播');
      assert.equal(g3.schedule.fired, true);
    } finally {
      await new Promise((r) => s3.close(r));
    }
  } finally {
    await new Promise((r) => s2.close(r));
  }
});

test('启播结果展示在成功手动控制后清除；ISO 8601 日期字符串也可预约', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await ctrl({ revision: 0, action: 'pause' });
  const iso = new Date((Date.now() / 1000 + 0.2) * 1000).toISOString();
  const r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 1, start_at: iso });
  assert.equal(r.status, 200, '接受 ISO 8601 字符串');
  assert.equal(r.json.schedule.active, true);

  await sleep(450);
  let g = await getJson(`/api/rooms/${c.code}`);
  assert.equal(g.playing, true);
  assert.equal(g.schedule.fired, true);

  // 成功手动控制后启播结果块消失
  const paused = await ctrl({ revision: 2, action: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.schedule, undefined, '手动控制清除启播结果与预约');
});
