// 오피스 패널 단계 보기(2단계 PR2) — 이 턴의 기록기(turn-trace)에서 가린 단계 요약만 화면용으로 뽑고, chat()이 기록기를 부른 쪽에 알린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-panel-steps-')); // import보다 먼저(레포 관례)
const { panelSteps, stepsMeta, liveSteps, LIVE_STEPS, KEPT_STEPS } = await import('../src/gateway/office-steps.mjs');
const { createTrace } = await import('../src/turn-trace.mjs');
const { chat } = await import('../src/chat.mjs');
const { createCompany } = await import('../src/workspace.mjs');

test('단계 요약 — 도구 단계만, 단계 코드와 가린 대상, 생각 원문은 싣지 않는다', () => {
  const tr = createTrace({ source: 'messenger' });
  tr.think('사용자는 견적을 원한다 — 비밀 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  tr.toolStart({ id: 't1', name: 'Read', input: { file_path: '/ws/vault/견적.md' } }); tr.toolEnd('t1', { result: '본문' });
  tr.toolStart({ id: 't2', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB" x' } });
  tr.toolStart({ id: 't3', name: 'mcp__crew__delegate', input: { to: 'luna', task: '영업 메일' } });
  const s = panelSteps(tr);
  assert.deepEqual(s.map((x) => x.stage), ['memory', 'shell', 'delegate']);
  assert.equal(s[0].detail, '견적.md');
  assert.equal(s[2].detail, 'luna');
  assert.ok(!JSON.stringify(s).includes('sk-ant-api03-B'), '명령 속 비밀은 가린다');
  assert.ok(!JSON.stringify(s).includes('견적을 원한다'), '생각 원문은 싣지 않는다');
  assert.deepEqual(stepsMeta(tr), { office_steps: { n: 3, steps: s } });
});

test('개수 상한 — 진행 중 12개, 답 글 20개(전체 수는 n)', () => {
  const tr = createTrace({ source: 'messenger' });
  for (let i = 0; i < 30; i++) tr.toolStart({ id: `t${i}`, name: 'Grep', input: { pattern: `p${i}` } });
  assert.equal(panelSteps(tr).length, LIVE_STEPS);
  const m = stepsMeta(tr).office_steps;
  assert.equal(m.n, 30); assert.equal(m.steps.length, KEPT_STEPS); assert.equal(m.steps.at(-1).detail, 'p29');
  assert.deepEqual(stepsMeta(createTrace({ source: 'messenger' })), {}, '단계 없는 턴은 싣지 않는다');
  assert.deepEqual(panelSteps(null), []);
});

test('chat()은 이 턴의 기록기를 onTrace로 알린다(러너가 없어 실패하는 턴도)', async () => {
  await createCompany('steps-ws', '단계사', 'captain');
  let seen = null;
  await chat('steps-ws', 'nobody', 'x', null, { onTrace: (t) => { seen = t; } }).catch(() => {});
  assert.ok(seen && typeof seen.compact === 'function', '기록기를 받았다');
});

test('대상 없는 작업 단계(TodoWrite·Task)는 빼고, 진행 방송용은 전체 수·수정 번호를 같이', () => {
  const tr = createTrace({ source: 'messenger' });
  tr.toolStart({ id: 'a', name: 'TodoWrite', input: { todos: [] } });
  tr.toolStart({ id: 'b', name: 'Read', input: { file_path: '/w/a.md' } });
  assert.deepEqual(panelSteps(tr), [{ stage: 'memory', detail: 'a.md' }]);
  const live = liveSteps(tr);
  assert.deepEqual(live.list, [{ stage: 'memory', detail: 'a.md' }]); assert.equal(live.n, 2); assert.ok(live.rev > 0);
  assert.equal(liveSteps(null), null);
});
