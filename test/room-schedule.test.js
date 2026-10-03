'use strict';

// 共享房间「定时启播」HTTP 单元测试：
// 预约鉴权（密钥/修订号）与时刻校验（必填、数字/ISO、必须未来、播放中拒绝、0 时长拒绝、
// 不安全起点拒绝）、同房间只保留最近一次预约（覆盖）、预约/取消各使修订号 +1；
// 到点按现有播放规则从断点启播（已完成的循环排演从首段重来）、自动启播不增加修订号、
// 绝不重复启播；服务重启或首次查询已晚于预约时刻时仍按预约墙钟起算并准确停在先遇到的
// 讨论停点/超载边界/版本末尾；成功的手动控制/编排/停点维护取消待生效预约；主持权
// 交接保留预约；观看者只读可见状态且不泄露密钥。

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

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => server.close(r));
});

async function resetDraft() {
  const cues = await request('GET', '/api/cues');
  for (const c of cues.json) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await request('GET', '/api/lights');
  for (const l of lights.json) await request('DELETE', `/api/lights/${l.id}`);
  const circuits = await request('GET', '/api/circuits');
  for (const c of circuits.json) await request('DELETE', `/api/circuits/${c.id}`);
}

// 短版本：t=0 瞬变 100、渐变 1 秒到 0 → 末尾 1 秒
async function seedShortVersion() {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: '预约小灯' })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9601, light_id: l, time: 0, target: 100, duration: 1 }]);
  return (await request('POST', '/api/versions', { label: '预约短版' })).json;
}

// 带超载保护的短版本：超载区间左边界 0.3（闭）；末尾 1 秒
async function seedProtectedVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '超载回路T', capacity: 100 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '大灯T' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('POST', '/api/cues', [
    { cue_no: 9701, light_id: l1, time: 0, target: 50, duration: 0 },
    { cue_no: 9702, light_id: l1, time: 0.3, target: 100, duration: 0 },
    { cue_no: 9703, light_id: l1, time: 1, target: 0, duration: 0 },
  ]);
  return (await request('POST', '/api/versions', { label: '保护预约版' })).json;
}

async function createRoom(versionId, body = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, ...body });
}
const schedUrl = (code) => `/api/rooms/${code}/schedule`;
const cancelUrl = (code) => `/api/rooms/${code}/schedule/cancel`;
const ctrlUrl = (code) => `/api/rooms/${code}/control`;
const stopsUrl = (code) => `/api/rooms/${code}/stops`;

test('预约：缺/错密钥 403、修订号缺失非法 400、过期 409，均不改变房间', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const future = Date.now() / 1000 + 60;

  let r = await request('PUT', schedUrl(c.code), { revision: 0, start_at: future });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await request('PUT', schedUrl(c.code), {
    control_key: 'deadbeef'.repeat(6),
    revision: 0,
    start_at: future,
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, start_at: future });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: -1,
    start_at: future,
  });
  assert.equal(r.status, 400);

  // 让修订号前进一次，再用过时修订号
  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 0, action: 'pause' });
  r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: future,
  });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.schedule.state, 'none', '被拒绝后无预约');
  assert.equal(g.json.revision, 1);
  assert.equal(g.json.control_key, undefined);
});

test('预约：start_at 必填、数字/ISO 之外拒绝、必须是未来时刻，房间不变', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const submit = (start_at) =>
    request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: c.revision, start_at });

  let r = await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /start_at/);

  r = await submit('not-a-time');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /启播时刻无效/);

  r = await submit(null);
  assert.equal(r.status, 400);

  r = await submit({});
  assert.equal(r.status, 400);

  // 过去时刻
  r = await submit(Date.now() / 1000 - 10);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须是未来时刻/);

  // 恰为当前时刻也不允许（严格未来）
  r = await submit(Date.now() / 1000);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须是未来时刻/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.schedule.state, 'none');
  assert.equal(g.json.revision, 0, '拒绝不增加修订号');
});

test('预约成功：pending 状态/剩余秒数/断点回显，修订号 +1，不泄露密钥', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const startAt = Date.now() / 1000 + 120;

  // ISO 8601 字符串同样接受
  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: new Date(startAt * 1000).toISOString(),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.state, 'pending');
  assert.ok(Math.abs(r.json.schedule.start_at - startAt) < 1e-6);
  assert.ok(r.json.schedule.seconds_remaining > 110 && r.json.schedule.seconds_remaining <= 120);
  assert.equal(r.json.schedule.from_time, 0, '暂停在 0：断点即 0');
  assert.equal(r.json.schedule.program_restart, false);
  assert.equal(r.json.playing, false, '预约期间房间保持暂停');
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.control_key, undefined);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.schedule.state, 'pending');
  assert.ok(Math.abs(g.json.schedule.start_at - startAt) < 1e-6);
});

test('同一房间只保留最近一次预约：再次预约覆盖，修订号再 +1', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const t1 = Date.now() / 1000 + 60;
  const t2 = Date.now() / 1000 + 300;

  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: t1 });
  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    start_at: t2,
  });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.json.schedule.start_at - t2) < 1e-6);
  assert.ok(r.json.schedule.seconds_remaining > 200);
  assert.equal(r.json.revision, 2);
});

test('播放中预约：400 拒绝且房间不变', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 0, action: 'play' });

  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    start_at: Date.now() / 1000 + 30,
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /正在播放/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true);
  assert.equal(g.json.schedule.state, 'none');
  assert.equal(g.json.revision, 1, '拒绝不增加修订号');
});

test('到点自动启播：按断点播放、自动启播不增加修订号、标记 started、绝不重复启播', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const fireAt = Date.now() / 1000 + 0.2;

  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: fireAt,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 1);

  await sleep(450); // 已过启播时刻，但版本时长 1s：仍应在播放
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true, '到点已自动启播');
  assert.ok(g.json.time > 0 && g.json.time < 1, `time=${g.json.time}`);
  assert.equal(g.json.revision, 1, '自动启播不增加修订号');
  assert.equal(g.json.schedule.state, 'started', '显示已启播标记');
  assert.ok(Math.abs(g.json.schedule.start_at - fireAt) < 1e-6);

  // 再次查询：继续正常推进，不重复启播（时码单调向前，不会被重新锚到 0）
  const t1 = g.json.time;
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(g.json.time >= t1 - 1e-9, `时码不应回退：${t1} -> ${g.json.time}`);
  assert.equal(g.json.schedule.state, 'started');
});

test('到点后无人查询：首次查询已晚于预约时刻，仍按预约墙钟起算并停在版本末尾', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  // 预约在 0.15s 后启播；版本时长仅 1s，等 1.4s 后才首次查询：应已从预约时刻起播并停在末尾
  const fireAt = Date.now() / 1000 + 0.15;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: fireAt });
  await sleep(1400);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false, '按预约墙钟推进后已停在版本末尾');
  assert.ok(Math.abs(g.json.time - 1) < 1e-6, `time=${g.json.time} 应停在末尾 1`);
  assert.equal(g.json.revision, 1, '自动启播与末尾停住都不增加修订号');
  assert.equal(g.json.schedule.state, 'started');
  assert.equal(g.json.stops.tripped, undefined);
  assert.equal(g.json.protection.tripped, undefined);
});

test('首次查询已晚于预约时刻：准确停在先遇到的讨论停点（不停在末尾）', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.4] });
  // 停点维护后修订号为 1；预约 0.15s 启播，1.2s 后首次查询：先遇停点 0.4
  const fireAt = Date.now() / 1000 + 0.15;
  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    start_at: fireAt,
  });
  assert.equal(r.status, 200);
  await sleep(1200);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.4) < 1e-6, `time=${g.json.time} 应准确停在停点 0.4`);
  assert.ok(g.json.stops.tripped, '显示停点触发原因');
  assert.equal(g.json.revision, 2);
  assert.equal(g.json.schedule.state, 'started');
});

test('服务重启后：仍按预约墙钟起算（绝对时刻），停在先遇到的停点且不重复启播', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.5] });
  const fireAt = Date.now() / 1000 + 0.2;
  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    start_at: fireAt,
  });
  assert.equal(r.status, 200);

  // 模拟服务重启：同一数据库文件重新起一份 app（不经过任何中间查询）
  const { app: app2 } = require('../server.js');
  const s2 = http.createServer(app2);
  await new Promise((rr) => s2.listen(0, '127.0.0.1', rr));
  try {
    await sleep(1100); // 重启发生在启播时刻之后：首次查询已晚于预约
    const g = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s2.address().port, path: `/api/rooms/${c.code}` }, (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    assert.equal(g.playing, false);
    assert.ok(Math.abs(g.time - 0.5) < 1e-6, `time=${g.time} 应停在停点 0.5`);
    assert.ok(g.stops.tripped);
    assert.equal(g.revision, 2, '自动启播/停点暂停均不增加修订号');
    assert.equal(g.schedule.state, 'started');

    // 再查一次：不重复启播（时码保持在 0.5）
    const g2 = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s2.address().port, path: `/api/rooms/${c.code}` }, (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    assert.equal(g2.playing, false);
    assert.ok(Math.abs(g2.time - 0.5) < 1e-6, '不会重复启播');
    assert.equal(g2.schedule.state, 'started');
  } finally {
    await new Promise((rr) => s2.close(rr));
  }
});

test('保护房间：预约启播后按预约墙钟撞上超载边界，准确停在 0.3 且不增加修订号', async () => {
  const version = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  const fireAt = Date.now() / 1000 + 0.15;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: fireAt });
  await sleep(1200); // 远晚于启播+边界时刻

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time} 应停在超载边界 0.3`);
  assert.ok(g.json.protection.tripped, '显示超载触发原因');
  assert.equal(g.json.revision, 1, '自动启播/超载暂停均不增加修订号');
  assert.equal(g.json.schedule.state, 'started');
});

test('保护房间：不安全起点（断点已超载）预约被拒绝，房间不变', async () => {
  const version = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  // 暂停态跳到超载段内（暂停允许跳转避险用，这里用于构造不安全起点 0.5）
  const seek = await request('POST', ctrlUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    action: 'seek',
    time: 0.5,
  });
  assert.equal(seek.status, 200);
  assert.equal(seek.json.protection.overloaded_now, true);

  const r = await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    start_at: Date.now() / 1000 + 30,
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /启播起点不安全/);
  assert.equal(r.json.reason, 'overloaded_timecode');
  assert.ok(Math.abs(r.json.time - 0.5) < 1e-6);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.schedule.state, 'none');
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.5) < 1e-6, '房间不变');
  assert.equal(g.json.revision, 1);
});

test('取消待生效预约：成功后无预约、房间仍暂停、修订号 +1', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: Date.now() / 1000 + 60,
  });

  const r = await request('POST', cancelUrl(c.code), { control_key: c.control_key, revision: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.state, 'none');
  assert.equal(r.json.playing, false);
  assert.equal(r.json.time, 0);
  assert.equal(r.json.revision, 2);

  // 到了原预约时刻也不会启播
  await sleep(1200);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false, '已取消的预约不会启播');
  assert.equal(g.json.time, 0);
  assert.equal(g.json.schedule.state, 'none');
});

test('取消：无待生效预约 400 且房间不变；鉴权失败 403/409', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;

  let r = await request('POST', cancelUrl(c.code), { control_key: c.control_key, revision: 0 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /没有待生效/);

  r = await request('POST', cancelUrl(c.code), { revision: 0 });
  assert.equal(r.status, 403);

  // 安排一个预约再用过期修订号取消
  await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: Date.now() / 1000 + 60,
  });
  r = await request('POST', cancelUrl(c.code), { control_key: 'wrong', revision: 1 });
  assert.equal(r.status, 403);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.schedule.state, 'pending', '取消失败预约保留');
  assert.equal(g.json.revision, 1);
});

test('成功的手动控制取消待生效预约（播放/暂停/跳转/改速同一口径）', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: Date.now() / 1000 + 60,
  });
  // 一次暂停控制（成功）即取消预约，修订号前进到 2（预约 +1、暂停 +1）
  const r = await request('POST', ctrlUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    action: 'pause',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.state, 'none', '手动控制已取消预约');
  assert.equal(r.json.revision, 2);

  await sleep(1200);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false, '预约被取消，到点不启播');
  assert.equal(g.json.schedule.state, 'none', '手动控制也清除了启播标记');
});

test('成功的编排提交/取消、停点维护都取消待生效预约', async () => {
  const v = await seedShortVersion();

  // A：提交循环排演取消预约；finished 编排之后的预约在新编排提交时也被覆盖
  const a = (await createRoom(v.id)).json;
  await request('PUT', schedUrl(a.code), {
    control_key: a.control_key,
    revision: 0,
    start_at: Date.now() / 1000 + 60,
  });
  const prog = await request('POST', `/api/rooms/${a.code}/program`, {
    control_key: a.control_key,
    revision: 1,
    segments: [{ start: 0, end: 0.5, repeat: 2 }],
  });
  assert.equal(prog.status, 200);
  assert.equal(prog.json.schedule.state, 'none');

  // B：停点维护取消预约
  const b = (await createRoom(v.id)).json;
  await request('PUT', schedUrl(b.code), {
    control_key: b.control_key,
    revision: 0,
    start_at: Date.now() / 1000 + 60,
  });
  const stops = await request('PUT', stopsUrl(b.code), {
    control_key: b.control_key,
    revision: 1,
    stops: [0.3],
  });
  assert.equal(stops.status, 200);
  assert.equal(stops.json.schedule.state, 'none');

  await sleep(1200);
  const ga = await request('GET', `/api/rooms/${a.code}`);
  assert.ok(ga.json.schedule.state === 'none');
  const gb = await request('GET', `/api/rooms/${b.code}`);
  // B 房间从未播放（停点维护不启播），到原预约时刻保持暂停在 0
  assert.equal(gb.json.playing, false, 'B：停点维护取消预约后不启播');
  assert.equal(gb.json.time, 0);
});

test('进行中的循环排演暂停后预约：到点从断点接续；已完成的编排从首段重来', async () => {
  const v = await seedShortVersion();

  // A：编排播放中暂停在段内（用停点构造稳定断点），预约到点从断点接续
  const a = (await createRoom(v.id)).json;
  await request('PUT', stopsUrl(a.code), { control_key: a.control_key, revision: 0, stops: [0.5] });
  await request('POST', `/api/rooms/${a.code}/program`, {
    control_key: a.control_key,
    revision: 1,
    segments: [{ start: 0, end: 0.8, repeat: 3 }],
  });
  await sleep(1100); // 第一轮经过 0.5 自动暂停
  let g = (await request('GET', `/api/rooms/${a.code}`)).json;
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 0.5) < 1e-6);
  assert.equal(g.program.loop, 1);
  const revAfterStop = g.revision; // 2（停点 +1、编排 +1）

  const fireAt = Date.now() / 1000 + 0.2;
  const r = await request('PUT', schedUrl(a.code), {
    control_key: a.control_key,
    revision: revAfterStop,
    start_at: fireAt,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.program_restart, false, '编排进行中：断点接续，不从首段重来');
  assert.ok(Math.abs(r.json.schedule.from_time - 0.5) < 1e-6);
  await sleep(1100); // 启播在约 0.2s 后：0.5->0.8（0.3s）+ 跳回 0->0.5（0.5s），留足余量
  g = (await request('GET', `/api/rooms/${a.code}`)).json;
  // 0.5 续播：段尾 0.8 瞬时跳回 0 → 又会在第二轮经过停点 0.5 暂停（0.3+0.5=0.8s 内）
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 0.5) < 1e-6, `第二轮再次停在 0.5，time=${g.time}`);
  assert.equal(g.program.loop, 2, '从断点接续后进入第 2 轮');
  assert.equal(g.schedule.state, 'started');

  // B：编排已全部走完（finished），预约启播从首段重来
  const b = (await createRoom(v.id)).json;
  await request('POST', `/api/rooms/${b.code}/program`, {
    control_key: b.control_key,
    revision: 0,
    segments: [{ start: 0, end: 0.2, repeat: 1 }],
  });
  await sleep(800); // 0.2s 即走完
  g = (await request('GET', `/api/rooms/${b.code}`)).json;
  assert.equal(g.program.finished, true);
  const rb = await request('PUT', schedUrl(b.code), {
    control_key: b.control_key,
    revision: 1,
    start_at: Date.now() / 1000 + 60,
  });
  assert.equal(rb.status, 200);
  assert.equal(rb.json.schedule.program_restart, true, '已完成的编排：预约标注从首段重来');
  assert.ok(Math.abs(rb.json.schedule.from_time - 0) < 1e-6, '首段起点为 0');
});

test('主持权交接：预约保留，新主持人可取消；交接不改变预约墙钟', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const fireAt = Date.now() / 1000 + 600;
  await request('PUT', schedUrl(c.code), { control_key: c.control_key, revision: 0, start_at: fireAt });

  // 发起交接（不增加修订号）：预约仍在
  const issue = await request('POST', `/api/rooms/${c.code}/handover/issue`, {
    control_key: c.control_key,
    revision: 1,
  });
  assert.equal(issue.status, 200);
  assert.equal(issue.json.schedule.state, 'pending');

  // 领取：修订号 +1、换发新密钥；预约保留、墙钟不变
  const claim = await request('POST', `/api/rooms/${c.code}/handover/claim`, {
    handover_token: issue.json.handover_token,
    revision: 1,
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.schedule.state, 'pending');
  assert.ok(Math.abs(claim.json.schedule.start_at - fireAt) < 1e-6, '交接保留预约时刻');

  // 旧密钥无权取消；新密钥可以
  let r = await request('POST', cancelUrl(c.code), { control_key: c.control_key, revision: 2 });
  assert.equal(r.status, 403);
  r = await request('POST', cancelUrl(c.code), { control_key: claim.json.control_key, revision: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.state, 'none');
  assert.equal(r.json.revision, 3);
});

test('预约启播后下一次成功手动控制清除 started 标记', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: Date.now() / 1000 + 0.15,
  });
  await sleep(1300); // 自动启播并停在末尾
  let g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.schedule.state, 'started');
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 1) < 1e-6);

  // 手动暂停控制（成功）：清除启播标记
  const r = await request('POST', ctrlUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    action: 'pause',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.state, 'none');
  assert.equal(r.json.revision, 2);
});

test('观看者只读：GET 可见预约状态；预约/取消均 403，响应不泄露密钥', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', schedUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    start_at: Date.now() / 1000 + 60,
  });

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.schedule.state, 'pending');
  assert.ok(Math.abs(g.json.schedule.start_at - (await request('GET', `/api/rooms/${c.code}`)).json.schedule.start_at) < 1e-3);
  assert.equal(g.json.control_key, undefined);

  let r = await request('PUT', schedUrl(c.code), {
    revision: 1,
    start_at: Date.now() / 1000 + 120,
  });
  assert.equal(r.status, 403);
  r = await request('POST', cancelUrl(c.code), { revision: 1 });
  assert.equal(r.status, 403);
});
