// 오피스 패널 쓰기 확인 카드(2단계 PR1) — 크루 도구 서버(SDK 인메모리 MCP)의 오피스 도구가 패널 턴에서는 실행하지 않고 카드로 모은다.
// 이 경로가 1단계에서 확인 없이 쓰던 길이다(mcp__crew는 SDK 자동 허용). 라이브 DB 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-panel-tool-')); // import보다 먼저(레포 관례)
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { makeCrewServer } = await import('../src/chat.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const WS = 'panel-tool';
await createCompany(WS, '패널사', 'captain');

async function call(mirrorCtx, name, args) {
  const srv = makeCrewServer(WS, 'ay', '에이', [], 0, [], mirrorCtx, 'ko');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.instance.connect(st);
  const client = new Client({ name: 't', version: '1' }); await client.connect(ct);
  try { return (await client.callTool({ name, arguments: args })).content[0].text; } finally { await client.close(); }
}

test('패널 턴: office_work task_add는 실행하지 않고 카드로, 맥락에 제안이 쌓인다', async () => {
  const ctx = { kind: 'msgr', uid: 'u1', origin: 'u1', channelKind: 'dm', channelId: 'ch', crewId: 'c', orgId: 'o', officePanel: true, proposals: [] };
  const out = await call(ctx, 'office_work', { action: 'task_add', title: '견적 회신' });
  assert.match(out, /확인 카드\(p1\)로 올렸다: 할 일 추가: 견적 회신/);
  assert.equal(ctx.proposals.length, 1);
});

test('대조군: 패널 턴이 아니면 처리기가 그대로 돈다(카드 없음)', async () => {
  const ctx = { kind: 'msgr', uid: 'u1', origin: 'u1', channelKind: 'dm', channelId: 'ch', crewId: 'c', office: true, handoffs: [] };
  const out = await call(ctx, 'office_work', { action: 'task_add', title: '견적 회신' });
  assert.ok(!/확인 카드/.test(out), out);
  assert.equal(ctx.proposals, undefined);
});

// 검수 M-a — 패널 턴에서 만든 예약·긴 작업은 나중 턴이 패널 사슬이라 오피스 쓰기가 늘 거절된다. 패널 턴에서는 만들지 않는다(메신저 1:1에서는 그대로)
test('패널 턴: 예약·긴 작업은 만들지 않고 메신저 1:1로 안내', async () => {
  const ctx = { kind: 'msgr', uid: 'u1', origin: 'u1', channelKind: 'dm', channelId: 'ch', crewId: 'c', orgId: 'o', officePanel: true, proposals: [], handoffs: [] };
  assert.match(await call(ctx, 'schedule_task', { title: '매일 메일', prompt: '메일 보고 할 일 등록', type: 'daily', time: '09:00' }), /예약·긴 작업을 만들지 않는다/);
  assert.match(await call(ctx, 'start_long_task', { title: '수집', prompt: 'x' }), /예약·긴 작업을 만들지 않는다/);
  const plain = { ...ctx, officePanel: undefined, proposals: undefined };
  assert.ok(!/예약·긴 작업을 만들지 않는다/.test(await call(plain, 'start_long_task', { title: '수집', prompt: 'x' })), '대조군 — 패널 턴이 아니면 관문 밖');
});
