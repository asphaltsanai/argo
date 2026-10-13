// 기억·공간 3단계 U1 — 메신저가 자리 행의 agent_id(msgr_agents)를 읽는 최소 경로. 행동 테스트(가짜 run).
//  · 새 DB: agent_id를 함께 읽고 묶음(groupAgents)에 싣는다. 묶음 판정은 여전히 agentKey(주인·회사·slug).
//  · 새 앱 + 옛 DB(열 없음, V3·V5): agent_id만 빼고 다시 읽어 같은 목록, 10분 동안 다시 묻지 않는다(DB 위생).
//  · 더 옛 서버(접속 시각 계산 열도 없음)의 42703은 삼키지 않는다 — crew-seen.mjs 폴백이 받아야 한다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { withAgentCol, agentCol, agentColMissing, groupAgents } from '../src/agent-groups.mjs';
import { readWithSeen, seenCol } from '../src/crew-seen.mjs';

const ROWS = [{ id: 'c1', owner_user_id: 'u', ws_id: 'w', slug: 's', org_id: 'o1', display_name: 'S' }, { id: 'c2', owner_user_id: 'u', ws_id: 'w', slug: 's', org_id: null, display_name: 'S' }];
const noCol = (name) => Object.assign(new Error(`column msgr_crews.${name} does not exist`), { code: '42703' });
// 가짜 PostgREST: 없는 열을 고르면 42703
const server = (cols) => { const calls = []; return { calls, run: async (sel) => { calls.push(sel); for (const c of ['agent_id', 'msgr_crew_seen']) if (sel.includes(c) && !cols.includes(c)) throw noCol(c); return ROWS.map((r) => (cols.includes('agent_id') && sel.includes('agent_id') ? { ...r, agent_id: 'A1' } : r)); } }; };
beforeEach(() => { agentCol.missingAt = 0; seenCol.missingAt = 0; });

test('새 DB — agent_id를 함께 읽고 묶음에 싣는다(묶음은 agentKey 그대로 한 줄)', async () => {
  const s = server(['agent_id', 'msgr_crew_seen']);
  const rows = await withAgentCol('id, slug', s.run);
  assert.deepEqual(s.calls, ['id, slug, agent_id']);
  const g = groupAgents(rows);
  assert.equal(g.length, 1); assert.equal(g[0].agent_id, 'A1');
});

test('새 앱 + 옛 DB — agent_id만 빼고 다시 읽어 같은 목록, 10분 동안은 처음부터 빼고 묻는다', async () => {
  let t = 1_000_000; const now = () => t;
  const s = server(['msgr_crew_seen']);
  const rows = await withAgentCol('id, slug', s.run, now);
  assert.deepEqual(s.calls, ['id, slug, agent_id', 'id, slug']);
  assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.agent_id === null));
  assert.equal(groupAgents(rows)[0].agent_id, null);
  t += 60_000; await withAgentCol('id, slug', s.run, now);
  assert.deepEqual(s.calls.slice(2), ['id, slug'], '실패할 요청을 다시 보내지 않는다');
  t += 600_001; await withAgentCol('id, slug', s.run, now);
  assert.equal(s.calls.at(-2), 'id, slug, agent_id', '10분 뒤에는 다시 확인(라이브 적용 뒤 재시작 없이 붙는다)');
});

test('접속 시각 폴백과 겹쳐도 — agent_id 없음은 안쪽에서 걸러 seenCol을 건드리지 않는다', async () => {
  const s = server(['msgr_crew_seen']);
  const rows = await readWithSeen('id, last_seen_at', (c) => withAgentCol(c, s.run));
  assert.equal(rows.length, 2);
  assert.equal(seenCol.missingAt, 0, '접속 시각 계산 열은 있는데 없다고 기억하면 10분 동안 전원 꺼짐으로 보인다');
});

test('더 옛 서버(계산 열도 agent_id도 없음) — 두 폴백이 차례로 받아 행 시각으로 읽는다', async () => {
  const s = server([]);
  const rows = await readWithSeen('id, last_seen_at', (c) => withAgentCol(c, s.run));
  assert.equal(rows.length, 2);
  assert.ok(seenCol.missingAt > 0); assert.ok(agentCol.missingAt > 0);
  assert.equal(s.calls.at(-1), 'id, last_seen_at');
});

test('agentColMissing — agent_id 이름이 든 열 없음만, 다른 42703·권한 오류는 아니다', () => {
  assert.ok(agentColMissing(noCol('agent_id')));
  assert.ok(agentColMissing({ message: "Could not find the 'agent_id' column of 'msgr_crews' in the schema cache" }));
  assert.ok(!agentColMissing(noCol('msgr_crew_seen')));
  assert.ok(!agentColMissing({ message: 'permission denied for table msgr_crews', code: '42501' }));
});

test('다른 오류는 그대로 던진다(폴백으로 숨기지 않는다)', async () => {
  await assert.rejects(withAgentCol('id', async () => { throw new Error('network down'); }), /network down/);
  assert.equal(agentCol.missingAt, 0);
});
