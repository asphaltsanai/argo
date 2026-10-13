// msgr-bot 'ok' 판정 기억(2026-10-13 로그 수집 과금 축소, 총괄 결정 A) — msgr_bot_gate는 getUpdates마다 1회(봇당 분당 약 3회)였다.
//  · 'ok'를 받은 토큰은 GATE_OK_TTL_S(60초) 동안 판정 RPC를 부르지 않는다. 정책 값: 'ok' → 거절로 바뀌어도 최대 60초 늦게 막힌다.
//  · 거절(plan_required)·판정 실패(fail-open)는 기억하지 않는다. 토큰 오류(401)·거절 판정은 기억을 지운다.
//  · 거부 기억(createRejectMemory — plan 300초·auth 900초)과 다른 Map — 키·만료가 섞이지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, createGateOkMemory, createRejectMemory, GATE_OK_TTL_S, REJECT_TTL_S } from '../supabase/functions/msgr-bot/core.js';

const T = 'tok-1', T2 = 'tok-2';
const pgErr = (message) => Object.assign(new Error(message), { code: 'P0001' });
function world({ verdict = 'ok' } = {}) {
  let t = 1_000_000; const calls = [];
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const state = { verdict, updatesErr: null };
  const planGate = async (token) => { calls.push(['gate', token]); const v = state.verdict; if (v instanceof Error) throw v; return v; };
  const rpc = async (fn, args) => { calls.push([fn, args.token]); if (state.updatesErr) throw state.updatesErr; return []; };
  const gateOk = createGateOkMemory({ now }); const rejects = createRejectMemory({ now });
  const poll = (token = T) => handle({ token, method: 'getUpdates', params: { timeout: 0, delivery_protocol: 1 } }, rpc, { now, sleep, planGate, rejects, gateOk });
  return { poll, calls, gateOk, rejects, state, advance: (ms) => { t += ms; }, gates: (token = T) => calls.filter(([k, tk]) => k === 'gate' && tk === token).length };
}

test("'ok' 판정은 60초 동안 기억 — 그 사이 getUpdates는 판정 RPC 없이 바로 업데이트 조회, 60초 뒤 다시 묻는다", async () => {
  assert.equal(GATE_OK_TTL_S, 60);
  const w = world();
  for (let i = 0; i < 5; i++) { const r = await w.poll(); assert.equal(r.status, 200); w.advance(10_000); } // 0·10·20·30·40초
  assert.equal(w.gates(), 1, '처음 한 번만 판정');
  assert.equal(w.calls.filter(([k]) => k === 'msgr_bot_updates_with_delivery').length, 5, '업데이트 조회는 매번');
  w.advance(20_000); // 첫 판정 뒤 60초 + α
  await w.poll();
  assert.equal(w.gates(), 2, '60초가 지나면 다시 판정');
});

test("정책 값: 'ok' → 거절로 바뀌면 최대 60초 늦게 막힌다(그 뒤 403, 거부 기억으로 넘어간다)", async () => {
  const w = world();
  await w.poll(); // 'ok' 기억
  w.state.verdict = 'plan_required'; // 주인이 Pro를 해지했다
  w.advance(59_000);
  assert.equal((await w.poll()).status, 200, '기억이 살아 있는 동안은 통과(정책 지연)');
  w.advance(1_000);
  const r = await w.poll();
  assert.equal(r.status, 403, '60초 뒤에는 거절');
  assert.equal(w.gateOk.size, 0, '거절 판정은 ok 기억을 지운다');
  assert.equal(w.gates(), 2);
});

test('거절(plan_required)은 기억하지 않는다 — 매번 판정해 거부 기억(REJECT_AFTER)으로 넘긴다', async () => {
  const w = world({ verdict: 'plan_required' });
  await w.poll(); await w.poll();
  assert.equal(w.gates(), 2, '거절 쪽은 ok 기억에 들어가지 않는다');
  assert.equal(w.gateOk.size, 0);
});

test('판정 실패로 통과시킨 경우(fail-open — 옛 DB·시간 초과)는 기억하지 않는다', async () => {
  const w = world({ verdict: new Error('Could not find the function public.msgr_bot_gate') });
  assert.equal((await w.poll()).status, 200, '종전처럼 막지 않는다');
  assert.equal(w.gateOk.size, 0);
  w.state.verdict = 'plan_required';
  assert.equal((await w.poll()).status, 403, '다음 요청은 다시 판정 — 실패를 ok로 굳히지 않는다');
});

test('토큰 오류(401)는 ok 기억을 지운다 — 판정에서 나든 업데이트 조회에서 나든', async () => {
  const w = world();
  await w.poll(); assert.equal(w.gateOk.size, 1);
  w.state.updatesErr = pgErr('msgr_bot_unauthorized');
  assert.equal((await w.poll()).status, 401);
  assert.equal(w.gateOk.size, 0, '업데이트 조회의 401');
  w.state.updatesErr = null; w.state.verdict = 'ok';
  await w.poll(); assert.equal(w.gateOk.size, 1);
  w.advance(61_000); w.state.verdict = pgErr('msgr_bot_unauthorized');
  assert.equal((await w.poll()).status, 401);
  assert.equal(w.gateOk.size, 0, '판정의 401');
});

test('거부 기억과 섞이지 않는다 — 다른 Map·다른 만료, 토큰마다 따로', async () => {
  const w = world();
  await w.poll(T); // T: ok 기억
  w.state.verdict = 'plan_required';
  for (let i = 0; i < 3; i++) await w.poll(T2); // T2: 거절 3번 → 거부 기억(plan 300초)
  assert.equal(w.gateOk.size, 1, 'ok 기억은 T 하나');
  assert.equal(w.rejects.size, 1, '거부 기억은 T2 하나');
  assert.equal(w.rejects.blocked(T), null, 'ok 토큰은 거부 기억에 없다');
  assert.equal(w.gateOk.fresh(T2), false, '거절 토큰은 ok 기억에 없다');
  assert.equal(REJECT_TTL_S.plan, 300, '거부 기억 TTL은 그대로(#987)');
  w.advance(61_000);
  assert.equal(w.gateOk.fresh(T), false, 'ok 기억은 60초에 만료');
  assert.equal(w.rejects.blocked(T2), 'plan', '거부 기억은 300초 동안 그대로');
});

test('gateOk를 넘기지 않으면(옛 호출) 종전처럼 요청마다 판정', async () => {
  let n = 0; let t = 0;
  for (let i = 0; i < 3; i++) await handle({ token: T, method: 'getUpdates', params: {} }, async () => [], { now: () => t, sleep: async (ms) => { t += ms; }, planGate: async () => { n += 1; return 'ok'; } });
  assert.equal(n, 3);
});
