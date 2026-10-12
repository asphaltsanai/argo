// 오피스 패널 쓰기 확인 카드(2단계 PR1) — 패널 턴의 오피스 쓰기는 실행하지 않고 제안으로 모으고, 카드 [실행]은 답 글의 제안을 인자 그대로 한 번 실행한다.
// 라이브 DB 호출 0 — 가짜 db·도구 정의.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelWriteGate, isWrite, alwaysConfirm, confirmOf, findProposal, proposalsMeta, proposalSummary, isPanelSource, PROPOSAL_MAX } from '../src/gateway/office-proposals.mjs';
import { officeToolSpecs } from '../src/gateway/office-tools.mjs';
import { runOfficeConfirm } from '../src/gateway/msgr.mjs';

const panel = (extra = {}) => ({ kind: 'msgr', uid: 'u1', officePanel: true, proposals: [], ...extra });

// 이유: 유건 10/11 결정 '쓰기 기본값: 늘 확인 카드' — 패널 에이전트가 도구로 바로 할 일을 만들던 경로(mcp__crew 자동 허용)를 닫는다
test('패널 턴의 쓰기는 실행하지 않고 카드로 모은다, 읽기는 그대로', () => {
  const ctx = panel();
  assert.equal(panelWriteGate(ctx, 'office_work', { action: 'tasks' }), null, '읽기는 실행');
  const out = panelWriteGate(ctx, 'office_work', { action: 'task_add', title: '견적 회신' });
  assert.match(out, /확인 카드\(p1\)/);
  assert.match(out, /실행했다고 말하지 말고/);
  assert.deepEqual(ctx.proposals, [{ pid: 'p1', tool: 'office_work', args: { action: 'task_add', title: '견적 회신' }, summary: '할 일 추가: 견적 회신' }]);
});

test('패널 턴이 아니면 관문을 지나지 않는다(맡기기·메신저·데스크톱 턴은 지금 그대로)', () => {
  assert.equal(panelWriteGate({ kind: 'msgr', office: true }, 'office_work', { action: 'task_add', title: 'x' }), null);
  assert.equal(panelWriteGate(null, 'office_work', { action: 'task_add', title: 'x' }), null);
});

test('같은 제안은 하나, 6번째부터는 올리지 않는다', () => {
  const ctx = panel();
  panelWriteGate(ctx, 'office_work', { action: 'task_add', title: 'a' });
  assert.match(panelWriteGate(ctx, 'office_work', { action: 'task_add', title: 'a' }), /이미 확인 카드\(p1\)/);
  for (let i = 1; i < PROPOSAL_MAX; i++) panelWriteGate(ctx, 'office_work', { action: 'task_add', title: `t${i}` });
  assert.equal(ctx.proposals.length, PROPOSAL_MAX);
  assert.match(panelWriteGate(ctx, 'office_work', { action: 'task_add', title: 'over' }), /5개까지/);
  assert.equal(ctx.proposals.length, PROPOSAL_MAX);
  assert.deepEqual(ctx.proposals.map((p) => p.pid), ['p1', 'p2', 'p3', 'p4', 'p5']);
});

test('바로 실행을 켜면 되돌릴 수 있는 쓰기는 실행, 되돌리기 어려운 일은 그래도 카드', () => {
  const ctx = panel({ officeAuto: true });
  assert.equal(panelWriteGate(ctx, 'office_work', { action: 'task_add', title: 'a' }), null);
  assert.match(panelWriteGate(ctx, 'office_deals', { action: 'deal_next', id: 'd1', to: 'contract' }), /확인 카드/);
  assert.match(panelWriteGate(ctx, 'calendar', { action: 'delete', id: 'e1' }), /확인 카드/);
  assert.match(panelWriteGate(ctx, 'office_work', { action: 'page_edit', id: 'p', mode: 'replace', text: 'x' }), /확인 카드/);
  assert.equal(panelWriteGate(ctx, 'office_work', { action: 'page_edit', id: 'p', text: 'x' }), null, '덧붙이기는 되돌릴 수 있다');
});

test('쓰기 목록은 도구 정의의 동작과 맞는다(새 동작이 생기면 분류를 정해야 한다)', () => {
  const reads = { calendar: ['list'], office: ['company', 'people', 'evals'], office_files: ['files', 'file_read', 'drive'], office_work: ['tasks', 'categories', 'pages', 'page_read'],
    office_deals: ['customers', 'deals'], office_mail: ['mails', 'mail_read'], office_briefing: ['briefs', 'brief_read'] };
  for (const spec of officeToolSpecs('ko')) {
    for (const action of spec.shape.action.options) {
      const read = reads[spec.name]?.includes(action);
      assert.equal(isWrite(spec.name, { action }), !read, `${spec.name}.${action}`);
    }
  }
  assert.equal(alwaysConfirm('office_deals', { action: 'deal_next', to: 'paid' }), false);
});

test('카드 문구는 동작과 대상을 적는다(ko·en)', () => {
  assert.equal(proposalSummary('office_mail', { action: 'mail_draft', subject: '견적 회신', to: 'kim@x.com' }), '메일 초안 쓰기: 견적 회신 → kim@x.com');
  assert.equal(proposalSummary('office_work', { action: 'task_add', title: 'Call back', due_on: '2026-10-20' }, 'en'), 'Add task: Call back · due 2026-10-20');
  assert.equal(proposalSummary('office_deals', { action: 'deal_next', id: 'd1', to: 'cancel' }), '거래를 취소합니다 (id d1).');
});

test('확인 표지 — 모양이 맞는 것만', () => {
  assert.deepEqual(confirmOf({ meta: { office_confirm: { reply: 42, pid: 'p2' } } }), { reply: 42, pid: 'p2' });
  assert.deepEqual(confirmOf({ meta: { office_confirm: { reply: '42', pid: 'p2' } } }), { reply: 42, pid: 'p2' });
  for (const bad of [{ reply: 0, pid: 'p1' }, { reply: 1.5, pid: 'p1' }, { reply: 1, pid: 'p0' }, { reply: 1, pid: 'x1' }, { reply: 1, pid: 'p10' }, [1], null, 'p1'])
    assert.equal(confirmOf({ meta: { office_confirm: bad } }), null, JSON.stringify(bad));
  assert.equal(isPanelSource({ meta: { source: 'office_panel' } }), true);
  assert.equal(isPanelSource({ meta: { source: 'office_mail' } }), false);
});

const reply = (extra = {}) => ({ id: 42, channel_id: 'ch1', author_kind: 'crew', crew_id: 'c1', meta: { office_proposals: [{ pid: 'p1', tool: 'office_work', args: { action: 'task_add', title: '견적 회신' }, summary: '할 일 추가: 견적 회신' }] }, ...extra });

test('제안 찾기 — 같은 방·이 에이전트의 답·그 pid·쓰기 동작만', () => {
  const q = { channelId: 'ch1', crewId: 'c1', pid: 'p1' };
  assert.equal(findProposal(reply(), q).tool, 'office_work');
  assert.equal(findProposal(reply({ channel_id: 'ch2' }), q), null, '다른 방');
  assert.equal(findProposal(reply({ crew_id: 'c2' }), q), null, '다른 에이전트');
  assert.equal(findProposal(reply({ author_kind: 'user' }), q), null, '사람 글(위조)');
  assert.equal(findProposal(reply({ deleted_at: '2026-10-12' }), q), null, '지운 글');
  assert.equal(findProposal(reply(), { ...q, pid: 'p2' }), null, '없는 pid');
  assert.equal(findProposal(reply({ meta: { office_proposals: [{ pid: 'p1', tool: 'office_work', args: { action: 'tasks' } }] } }), q), null, '읽기 동작은 실행 경로로 오지 않는다');
  assert.equal(findProposal(reply({ meta: { office_proposals: [{ pid: 'p1', tool: 'Bash', args: { action: 'x' } }] } }), q), null, '오피스 도구가 아님');
  assert.deepEqual(proposalsMeta({ proposals: [] }), {});
  assert.equal(proposalsMeta(panel({ proposals: reply().meta.office_proposals })).office_proposals.length, 1);
});

const job = (extra = {}) => ({ channelId: 'ch1', crewId: 'c1', slug: 'pepper', authorId: 'u1', officeConfirm: { reply: 42, pid: 'p1' }, ...extra });
const fakeDeps = (calls) => ({ owner: async () => 'u1', specs: () => [{ name: 'office_work', run: async (args, o) => { calls.push({ args, o }); return '할 일을 만들었다'; } }] });

test('카드 [실행] — 답 글의 제안을 인자 그대로 한 번 실행하고 결과를 턴에 넘긴다', async () => {
  const calls = [];
  const db = { message: async (id) => (id === 42 ? reply() : null) };
  const r = await runOfficeConfirm(db, { wsId: 'w', job: job(), ctx: panel({ channelId: 'ch1' }), uid: 'u1', lang: 'ko', crewName: '페퍼' }, fakeDeps(calls));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { action: 'task_add', title: '견적 회신' });
  assert.equal(calls[0].o.ownerId, 'u1');
  assert.equal(calls[0].o.ctx.officePanel, false, '실행 경로는 관문을 다시 타지 않는다');
  assert.equal(r.result, '할 일을 만들었다');
  assert.equal(r.status, 'ran');
  assert.match(r.note, /이미 한 번 실행했다: 할 일 추가: 견적 회신/);
  assert.match(r.note, /같은 동작을 다시 부르지 마라/);
});

test('카드 [실행] — 남이 쓴 확인 글·찾을 수 없는 제안은 실행하지 않는다', async () => {
  for (const [name, j, msg] of [['다른 사람', job({ authorId: 'u2' }), reply()], ['다른 방의 답', job(), reply({ channel_id: 'ch9' })], ['없는 글', job(), null]]) {
    const calls = [];
    const r = await runOfficeConfirm({ message: async () => msg }, { wsId: 'w', job: j, ctx: panel(), uid: 'u1', lang: 'ko' }, fakeDeps(calls));
    assert.equal(calls.length, 0, name);
    assert.equal(r.result, null, name);
    assert.equal(r.status, 'not_found', name);
    assert.match(r.note, /찾지 못해 아무것도 실행하지 않았다/, name);
  }
});

test('카드 [실행] — 도구가 던져도 턴은 이어간다(오류를 결과로)', async () => {
  const r = await runOfficeConfirm({ message: async () => reply() }, { wsId: 'w', job: job(), ctx: panel(), uid: 'u1', lang: 'en' },
    { owner: async () => 'u1', specs: () => [{ name: 'office_work', run: async () => { throw new Error('rpc down'); } }] });
  assert.match(r.result, /Error while running: rpc down/);
  assert.equal(r.status, 'error', '카드가 실행하지 못함으로 보이게');
});

// 검수 M1 — 패널에서 시작한 일이 넘김·예약·긴 작업·결재 후속으로 다른 턴이 되면 그 답은 패널 카드로 오지 않는다. 쓰기는 거절, 읽기는 그대로
test('패널 사슬의 다른 턴은 오피스 쓰기를 하지 않는다(카드도 만들지 않음)', () => {
  const ctx = { kind: 'msgr', officePanelChain: true };
  assert.match(panelWriteGate(ctx, 'office_work', { action: 'task_add', title: 'a' }), /오피스 에이전트 창에서 다시 요청/);
  assert.equal(ctx.proposals, undefined, '카드 없음');
  assert.equal(panelWriteGate(ctx, 'office_work', { action: 'tasks' }), null, '읽기는 그대로');
  assert.match(panelWriteGate({ ...ctx, officePanel: true, proposals: [] }, 'office_work', { action: 'task_add', title: 'a' }), /확인 카드\(p1\)/, '패널 턴 자신은 카드');
});

test('제안 크기 — 하나 8000바이트, 한 답 합계 16000바이트(meta 열 제약에 못 미치게)', () => {
  const ctx = panel();
  const big = '가'.repeat(2500); // 7500바이트
  assert.match(panelWriteGate(ctx, 'office_work', { action: 'page_add', title: 'x', text: '가'.repeat(2700) }), /너무 커서/, '하나가 8000바이트 넘음');
  panelWriteGate(ctx, 'office_work', { action: 'page_add', title: 'a', text: big });
  panelWriteGate(ctx, 'office_work', { action: 'page_add', title: 'b', text: big });
  assert.match(panelWriteGate(ctx, 'office_work', { action: 'page_add', title: 'c', text: '가'.repeat(400) }), /너무 커서/, '합계 16000 넘음');
  assert.equal(ctx.proposals.length, 2);
});

test('늘 카드 — 회사 정보 덮어쓰기, 반복 일정 여러 회차 고치기', () => {
  assert.equal(alwaysConfirm('office', { action: 'company_set', id: 'x', value: '1' }), true);
  assert.equal(alwaysConfirm('calendar', { action: 'update', id: 'e', scope: 'all' }), true);
  assert.equal(alwaysConfirm('calendar', { action: 'update', id: 'e', scope: 'following' }), true);
  assert.equal(alwaysConfirm('calendar', { action: 'update', id: 'e', scope: 'this' }), false);
  assert.equal(alwaysConfirm('calendar', { action: 'update', id: 'e' }), false);
});

test('확인 턴의 문구는 저장된 summary가 아니라 실행할 인자로 다시 만든다', async () => {
  const forged = reply({ meta: { office_proposals: [{ pid: 'p1', tool: 'office_work', args: { action: 'task_add', title: '진짜 제목' }, summary: '가짜 문구' }] } });
  const r = await runOfficeConfirm({ message: async () => forged }, { wsId: 'w', job: job(), ctx: panel(), uid: 'u1', lang: 'ko' }, fakeDeps([]));
  assert.match(r.note, /할 일 추가: 진짜 제목/);
  assert.ok(!r.note.includes('가짜 문구'));
});
