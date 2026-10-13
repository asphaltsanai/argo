// 거부를 받고도 계속 오는 봇(2026-10-13, 엣지 호출 30일 추정 133%) — 엣지(supabase/functions/msgr-bot/core.js)의 값싼 거절과 재시도 시각.
// 잠그는 것: ① 무료 주인 봇은 REJECT_AFTER번 거부 뒤 TTL 동안 DB를 부르지 않는다(403 + retry_after, 롱폴 시간만큼 붙잡는 박자 그대로)
//   ② 무효 토큰(401)도 같다  ③ 정상 봇(Pro·유효 토큰)은 기억에 들어가지 않고 요청당 DB 호출 수가 종전과 같다
//   ④ 성공 한 번이면 지운다(Pro로 바꾼 뒤 이 인스턴스에서도 바로 풀린다 — 기억에 오르기 전이면)  ⑤ TTL이 지나면 다시 DB에 묻는다
//   ⑥ 받기(getUpdates) 밖의 401은 기억하지 않는다  ⑦ 메모리 상한  ⑧ 기억이 없으면(옛 배포 호출) 종전과 같다
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, createRejectMemory, REJECT_AFTER, REJECT_TTL_S } from '../supabase/functions/msgr-bot/core.js';

const T = 'argo_bot_' + 'a'.repeat(48);
const pgErr = (name) => Object.assign(new Error(name), { code: 'P0001' });
function world({ plan = 'ok', updates = [], unauthorized = false } = {}) {
  let t = 1_000_000; const slept = []; const calls = [];
  const now = () => t;
  const sleep = async (ms) => { slept.push(ms); t += ms; };
  const rpc = async (fn) => { calls.push(fn); if (unauthorized) throw pgErr('msgr_bot_unauthorized'); return fn === 'msgr_bot_events' ? [] : updates; };
  const planGate = async () => { calls.push('msgr_bot_gate'); if (unauthorized) throw pgErr('msgr_bot_unauthorized'); return plan; };
  const rejects = createRejectMemory({ now });
  const poll = (method = 'getUpdates') => handle({ token: T, method, params: { timeout: 20, delivery_protocol: 1 } }, rpc, { now, sleep, planGate, rejects, maxWaitMs: 25_000 });
  return { poll, calls, slept, rejects, advance: (ms) => { t += ms; }, set: (o) => { plan = o.plan ?? plan; updates = o.updates ?? updates; unauthorized = o.unauthorized ?? unauthorized; } };
}

test('① 무료 주인 봇 — REJECT_AFTER번 거부 뒤에는 DB를 부르지 않고 403 + retry_after, 붙잡는 시간은 종전과 같다', async () => {
  const w = world({ plan: 'plan_required' });
  for (let i = 0; i < REJECT_AFTER; i++) { const r = await w.poll(); assert.equal(r.status, 403); assert.equal(r.body.parameters.retry_after, REJECT_TTL_S.plan); }
  assert.equal(w.calls.length, REJECT_AFTER, '처음 REJECT_AFTER번은 판정 RPC 1회씩');
  for (let i = 0; i < 14; i++) { // 14 × 20초 = 280초 < TTL 300초
    const r = await w.poll();
    assert.equal(r.status, 403);
    assert.equal(r.body.error_code, 403);
    assert.match(r.body.description, /Argo Pro/);
    assert.equal(r.body.parameters.retry_after, REJECT_TTL_S.plan);
  }
  assert.equal(w.calls.length, REJECT_AFTER, '기억된 동안 DB 호출 0');
  assert.ok(w.slept.every((ms) => ms === 20_000), `롱폴 시간만큼 붙잡는다(옛 도구 박자 그대로): ${[...new Set(w.slept)]}`);
});

test('② 무효 토큰 — REJECT_AFTER번 401 뒤 DB 없이 401 + retry_after(TTL)', async () => {
  const w = world({ unauthorized: true });
  for (let i = 0; i < REJECT_AFTER + 20; i++) { const r = await w.poll(); assert.equal(r.status, 401); assert.equal(r.body.parameters.retry_after, REJECT_TTL_S.auth); }
  assert.equal(w.calls.length, REJECT_AFTER);
});

test('③ 정상 봇(Pro·유효 토큰) — 기억에 들어가지 않고 요청당 DB 호출은 종전과 같다(판정 1 + 받기 1), 응답에 retry_after 없음', async () => {
  const w = world({ plan: 'ok', updates: [{ update_id: 1 }] });
  for (let i = 0; i < 30; i++) { const r = await w.poll(); assert.equal(r.status, 200); assert.equal(r.body.parameters, undefined); }
  assert.equal(w.calls.length, 60);
  assert.equal(w.rejects.size, 0);
  assert.deepEqual(w.slept, [], '받을 글이 있으면 기다리지 않는다');
});

test('④ 성공 한 번이면 거부 횟수를 지운다 — 기억(차단)에 오르기 전 Pro로 바뀐 봇은 바로 정상', async () => {
  const w = world({ plan: 'plan_required' });
  for (let i = 0; i < REJECT_AFTER - 1; i++) await w.poll();
  w.set({ plan: 'ok', updates: [{ update_id: 1 }] });
  assert.equal((await w.poll()).status, 200);
  assert.equal(w.rejects.size, 0);
  w.set({ plan: 'plan_required' });
  const before = w.calls.length;
  for (let i = 0; i < REJECT_AFTER; i++) await w.poll();
  assert.equal(w.calls.length - before, REJECT_AFTER, '횟수가 처음부터 다시');
});

test('⑤-a TTL이 지나면 DB에 한 번 묻고, 또 거부면 곧바로 다시 기억한다(TTL당 DB 1회)', async () => {
  const w = world({ plan: 'plan_required' });
  for (let i = 0; i < REJECT_AFTER; i++) await w.poll();
  w.advance(REJECT_TTL_S.plan * 1000);
  const before = w.calls.length;
  for (let i = 0; i < 14; i++) assert.equal((await w.poll()).status, 403);
  assert.equal(w.calls.length - before, 1);
});

test('⑤ TTL이 지나면 다시 DB에 묻는다 — Pro로 바꾼 주인의 봇은 늦어도 TTL 뒤 풀린다', async () => {
  const w = world({ plan: 'plan_required' });
  for (let i = 0; i < REJECT_AFTER; i++) await w.poll();
  w.set({ plan: 'ok', updates: [{ update_id: 9 }] });
  assert.equal((await w.poll()).status, 403, '기억된 동안은 거부');
  w.advance(REJECT_TTL_S.plan * 1000);
  const r = await w.poll();
  assert.equal(r.status, 200);
  assert.equal(w.rejects.size, 0);
});

test('⑥ 받기 밖의 401(sendMessage 등)은 기억하지 않는다 — 사람이 부를 때만 오는 호출', async () => {
  const w = world({ unauthorized: true });
  const send = () => handle({ token: T, method: 'getMe' }, async (fn) => { w.calls.push(fn); throw pgErr('msgr_bot_unauthorized'); }, { rejects: w.rejects });
  for (let i = 0; i < REJECT_AFTER + 2; i++) assert.equal((await send()).status, 401);
  assert.equal(w.calls.length, REJECT_AFTER + 2);
  assert.equal(w.rejects.blocked(T), null);
});

test('⑦ 메모리 상한 — 토큰이 아무리 많아도 5,000개를 넘지 않는다', () => {
  const m = createRejectMemory();
  for (let i = 0; i < 6_000; i++) m.reject(`t${i}`, 'auth');
  assert.equal(m.size, 5_000);
});

test('⑧ 기억을 넘기지 않으면(옛 호출) 종전과 같다 — 매번 판정 RPC, 403에 retry_after만 더해진다', async () => {
  let n = 0; let t = 0;
  for (let i = 0; i < 5; i++) {
    const r = await handle({ token: T, method: 'getUpdates', params: { timeout: 1 } }, async () => [], { now: () => t, sleep: async (ms) => { t += ms; }, planGate: async () => { n += 1; return 'plan_required'; } });
    assert.equal(r.status, 403);
  }
  assert.equal(n, 5);
});
