// msgr-bot 판정을 롱폴 첫 조회에 합치기(2026-10-13 로그 수집 과금 축소 ①) — 엣지가 msgr_bot_gate를 따로 부르지 않는다.
//  · gateInUpdates: 첫 조회만 msgr_bot_updates_with_delivery(…, gate: true). 막히면 msgr_bot_plan_required → 롱폴 시간만큼 붙잡았다가 403 + Retry-After(종전 형식).
//  · 새 엣지 + 옛 DB(네 인자 함수 없음 — PostgREST 'Could not find the function'): 종전 경로(msgr_bot_gate 1회 + 세 인자 조회)로 물러난다 — 판정이 빠지지 않는다.
//  · 옛 연결 경로(delivery_protocol 없음 → msgr_bot_updates)·gateInUpdates를 넘기지 않는 호출: 종전 경로 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, createRejectMemory, REJECT_TTL_S } from '../supabase/functions/msgr-bot/core.js';

const T = 'tok';
const missingFn = () => new Error('Could not find the function public.msgr_bot_updates_with_delivery(after_id, gate, lim, token) in the schema cache');
function world({ updates = () => [], gate = 'ok', gateInUpdates = true } = {}) {
  let t = 0; const calls = [];
  const rpc = async (fn, args) => { calls.push([fn, { ...args }]); return fn === 'msgr_bot_events' ? [] : updates(args, calls.filter(([f]) => f === fn).length); };
  const planGate = async () => { calls.push(['msgr_bot_gate', {}]); if (gate instanceof Error) throw gate; return gate; };
  const rejects = createRejectMemory({ now: () => t });
  const poll = (params = { timeout: 20, delivery_protocol: 1 }) => handle({ token: T, method: 'getUpdates', params }, rpc, { now: () => t, sleep: async (ms) => { t += ms; }, planGate, rejects, gateInUpdates });
  return { poll, calls, rejects, now: () => t, names: () => calls.map(([f]) => f) };
}

test('새 DB: 첫 조회에만 gate: true, 그 뒤 조회는 gate 없이 — msgr_bot_gate 0회(20초 빈 대기 RPC 5회 = 종전 판정 1 + 조회 5에서 1회 줄어듦)', async () => {
  const w = world();
  const r = await w.poll();
  assert.equal(r.status, 200);
  assert.deepEqual(w.names(), Array(5).fill('msgr_bot_updates_with_delivery'));
  assert.deepEqual(w.calls.map(([, a]) => a.gate ?? null), [true, null, null, null, null], '판정은 첫 조회 한 번');
  assert.equal(w.now(), 20_000);
});

test('새 DB: 무료 주인이면 첫 조회가 msgr_bot_plan_required — 롱폴 시간만큼 붙잡고 403 + Retry-After(종전 형식), 이벤트·추가 조회 없음, 거부 기억에 적는다', async () => {
  const w = world({ updates: (a) => { if (a.gate) throw new Error('msgr_bot_plan_required'); return []; } });
  const r = await w.poll({ timeout: 20, delivery_protocol: 1, events: 1 });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body.parameters, { retry_after: REJECT_TTL_S.plan }, 'retry_after = plan 300초(#987 계약 그대로)');
  assert.equal(r.body.error_code, 403);
  assert.deepEqual(w.names(), ['msgr_bot_updates_with_delivery'], '판정 겸 첫 조회 1회뿐 — 이벤트·msgr_bot_gate 없음');
  assert.equal(w.now(), 20_000, '롱폴 시간만큼 붙잡는다(종전과 같은 박자)');
  await w.poll(); await w.poll();
  assert.equal(w.rejects.blocked(T), 'plan', '연달아 거절되면 거부 기억(#987)이 그대로 동작');
});

test('새 엣지 + 옛 DB(네 인자 함수 없음): 종전 경로로 물러난다 — msgr_bot_gate 1회 판정 후 세 인자 조회, 무료 주인은 그대로 403', async () => {
  const ok = world({ updates: (a) => { if (a.gate) throw missingFn(); return []; } });
  assert.equal((await ok.poll()).status, 200);
  assert.deepEqual(ok.names().slice(0, 2), ['msgr_bot_updates_with_delivery', 'msgr_bot_gate'], '함수 없음 → 판정 따로');
  assert.ok(ok.calls.slice(2).every(([f, a]) => f === 'msgr_bot_updates_with_delivery' && a.gate === undefined), '그 뒤 조회는 세 인자');
  const free = world({ updates: (a) => { if (a.gate) throw missingFn(); return []; }, gate: 'plan_required' });
  assert.equal((await free.poll()).status, 403, '판정이 빠지지 않는다');
  assert.deepEqual(free.names(), ['msgr_bot_updates_with_delivery', 'msgr_bot_gate']);
});

test('첫 조회의 다른 오류는 msgr_bot_gate로 물러나지 않는다 — 토큰 오류는 401(종전), 시간 초과가 이어지면 gate 없는 재조회도 실패해 종전처럼 실패 응답', async () => {
  const revoked = world({ updates: () => { throw new Error('msgr_bot_unauthorized'); } });
  const r = await revoked.poll();
  assert.equal(r.status, 401);
  assert.ok(!revoked.names().includes('msgr_bot_gate'), '토큰 오류에 판정 경로로 물러나지 않는다');
  assert.equal(revoked.calls.length, 1, '토큰 오류는 다시 조회하지 않는다(로그 1줄)');
  const slow = world({ updates: () => { throw new Error('canceling statement due to statement timeout'); } });
  const r2 = await slow.poll();
  assert.ok(r2.status >= 500, `시간 초과는 실패 응답(${r2.status})`);
  assert.ok(!slow.names().includes('msgr_bot_gate'));
});

test('글이 이미 쌓여 있으면 첫 조회(판정 겸)에서 바로 돌려준다', async () => {
  const up = { update_id: 3, message: { message_id: 3, text: 'hi' } };
  const w = world({ updates: () => [up] });
  const r = await w.poll({ timeout: 20, delivery_protocol: 1, events: 1 });
  assert.deepEqual(r.body.result, [up]);
  assert.deepEqual(w.names(), ['msgr_bot_updates_with_delivery', 'msgr_bot_events'], '첫 조회 뒤 이벤트 1회');
  assert.equal(w.now(), 0);
});

test('옛 연결 경로(delivery_protocol 없음 → msgr_bot_updates)와 gateInUpdates 없는 호출은 종전 경로(판정 따로)', async () => {
  const legacyPath = world();
  await legacyPath.poll({ timeout: 0 });
  assert.deepEqual(legacyPath.names(), ['msgr_bot_gate', 'msgr_bot_updates']);
  const oldCaller = world({ gateInUpdates: false });
  await oldCaller.poll({ timeout: 0, delivery_protocol: 1 });
  assert.deepEqual(oldCaller.names(), ['msgr_bot_gate', 'msgr_bot_updates_with_delivery']);
  assert.equal(oldCaller.calls[1][1].gate, undefined);
});

// 검수 2 #999(MEDIUM) — 배포본은 판정이 실패하면 막지 않는다(fail-open). 판정이 첫 조회에 합쳐져도 판정 쪽 오류(함수 drop → 42883,
// is_pro_for·중지 기록·설정 오류)가 수신을 끊으면 안 된다: 경고만 남기고 판정 없이(msgr_bot_gate도 부르지 않고) gate 없는 조회로 다시 받는다.
test('첫 조회의 판정 쪽 오류(42883 함수 없음 등)는 막지 않는다 — 판정 없이 gate 없는 조회로 다시 받아 200(배포본 fail-open과 같음)', async () => {
  const up = { update_id: 5, message: { message_id: 5, text: 'hi' } };
  const w = world({ updates: (a) => { if (a.gate) throw new Error('function public.msgr_bot_gate(text) does not exist'); return [up]; }, gate: 'plan_required' });
  const r = await w.poll();
  assert.equal(r.status, 200, '판정 오류로 수신이 끊기지 않는다');
  assert.deepEqual(r.body.result, [up]);
  assert.deepEqual(w.names(), ['msgr_bot_updates_with_delivery', 'msgr_bot_updates_with_delivery'], '오류가 날 때만 1회 더 — msgr_bot_gate는 부르지 않는다');
  assert.deepEqual(w.calls.map(([, a]) => a.gate ?? null), [true, null]);
  for (const msg of ['canceling statement due to statement timeout', 'relation "public.msgr_crew_pauses" does not exist']) {
    const x = world({ updates: (a) => { if (a.gate) throw new Error(msg); return []; } });
    assert.equal((await x.poll({ timeout: 0, delivery_protocol: 1 })).status, 200, msg);
  }
});
