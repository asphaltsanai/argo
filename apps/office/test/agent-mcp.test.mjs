// 오피스 원격 MCP(2026-10-13 오피스 독립 앱 분리) — 도구 목록, 조직 고르기, 쓰기는 대기 변경으로, 읽기는 사용자 세션으로 실행, HTTP 인증(401·메타데이터), 대기 변경 [실행].
// 가짜 supabase 클라이언트만 쓴다(라이브 DB·네트워크 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officeMcp, resolveOrg, remoteSpecs, specFor, runSpec } from '../server/agent/mcp.js';
import { remoteContext, audienceOf } from '../server/agent/audience.js';
import { handle } from '../api/mcp.js';
import { run } from '../api/agent/actions.js';
import { GET as resourceGet } from '../api/oauth-resource.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const TOK = 'tok_abcdefghijklmnopqrstuvwxyz';
const ORG2 = '22222222-2222-4222-8222-222222222222';
/** 가짜 사용자 세션 — rpc 호출을 적고, 함수 이름별 응답을 돌려준다. from(msgr_org_members)는 조직 목록 */
function fakeSession({ orgs = [{ id: ORG, name: '알파', slug: 'alpha', role: 'owner' }], rpc = {} } = {}) {
  const calls = [];
  const client = {
    rpc: async (fn, args) => { calls.push({ fn, args }); const r = rpc[fn]; return typeof r === 'function' ? r(args) : { data: r ?? null, error: null }; },
    from: () => {
      const q = { select: () => q, eq: () => q, is: async () => ({ data: orgs.map((o) => ({ role: o.role, org: { id: o.id, name: o.name, slug: o.slug, deleted_at: null } })), error: null }) };
      return q;
    },
  };
  return { c: { client, uid: 'u1', token: 'tok' }, calls };
}

test('도구 목록 — 오피스 도구 7종 + 조직·대기 변경, 전부 읽기 전용 표시, 원격에서 막은 동작은 없다', () => {
  const { tools } = officeMcp({ lang: 'ko' });
  assert.deepEqual(tools.map((t) => t.name).sort(), ['calendar', 'office', 'office_actions', 'office_briefing', 'office_deals', 'office_files', 'office_mail', 'office_orgs', 'office_work'].sort());
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
  const actionsOf = (n) => tools.find((t) => t.name === n).inputSchema.properties.action.enum;
  assert.ok(!actionsOf('calendar').includes('delete'), '일정 삭제는 원격에서 열지 않는다');
  assert.ok(!actionsOf('office_files').includes('attach'), '서버는 에이전트 컴퓨터 파일을 읽을 수 없다');
  assert.ok(tools.find((t) => t.name === 'office_work').inputSchema.properties.org, 'org 인자');
  assert.match(tools.find((t) => t.name === 'office_work').description, /대기 변경/);
  assert.equal(specFor('calendar', 'delete'), null, '[실행]으로도 막은 동작은 돌지 않는다');
});

test('조직 고르기 — 하나면 그 조직, 여럿이면 고르게, 손님 조직·남의 조직 id는 거절, 개인 도구는 비우면 개인 공간', async () => {
  const one = fakeSession().c;
  assert.deepEqual(await resolveOrg(one, ''), { org: ORG });
  assert.deepEqual(await resolveOrg(one, 'alpha'), { org: ORG });
  assert.deepEqual(await resolveOrg(one, '', { personal: true }), { org: null });
  const two = fakeSession({ orgs: [{ id: ORG, name: '알파', slug: 'alpha', role: 'owner' }, { id: ORG2, name: '베타', slug: 'beta', role: 'member' }] }).c;
  assert.match((await resolveOrg(two, '')).error, /조직을 골라야/);
  assert.deepEqual(await resolveOrg(two, '베타'), { org: ORG2 });
  const guest = fakeSession({ orgs: [{ id: ORG, name: '알파', slug: 'alpha', role: 'guest' }] }).c;
  assert.match((await resolveOrg(guest, ORG)).error, /구성원이 아니다/);
  assert.match((await resolveOrg(one, ORG2)).error, /구성원이 아니다/);
});

test('쓰기 — 실행하지 않고 대기 변경(office_agent_action_add)으로, 처리기는 돌지 않는다', async () => {
  const { c, calls } = fakeSession({ rpc: { office_agent_action_add: 'aaaaaaaa-0000-4000-8000-000000000001' } });
  const r = await officeMcp().call('office_work', { action: 'task_add', title: '견적 회신', org: 'alpha' }, { c, source: 'Argo' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /대기 변경으로 올렸다.*할 일 추가: 견적 회신/s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'office_agent_action_add');
  assert.deepEqual(calls[0].args, { p_org: ORG, p_tool: 'office_work', p_action: 'task_add', p_args: { action: 'task_add', title: '견적 회신' }, p_summary: '할 일 추가: 견적 회신', p_source: 'Argo' });
});

test('쓰기 — 대기 변경 상한(50개)·오류는 오류로 알린다', async () => {
  const { c } = fakeSession({ rpc: { office_agent_action_add: () => ({ data: null, error: { message: 'agent_action_limit' } }) } });
  const r = await officeMcp().call('office_work', { action: 'task_add', title: 'x' }, { c });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /50개/);
});

test('읽기 — 그 사용자 세션으로 처리기를 바로 실행한다(조직 인자 그대로)', async () => {
  const { c, calls } = fakeSession({ rpc: { office_task_list: [{ id: 't1', title: '견적 회신', status: 'todo', assignee: 'u1', created_by: 'u1' }] } });
  const r = await officeMcp().call('office_work', { action: 'tasks' }, { c });
  assert.match(r.content[0].text, /견적 회신/);
  assert.deepEqual(calls.find((x) => x.fn === 'office_task_list').args, { p_org: ORG });
});

test('입력 검증 — 모양이 틀리면 오류(처리기·대기열 둘 다 안 감)', async () => {
  const { c, calls } = fakeSession();
  const r = await officeMcp().call('office_work', { action: 'nope' }, { c });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  assert.equal((await officeMcp().call('Bash', {}, { c })).isError, true);
});

test('원격 문맥 — 회사·문서함은 org 판정(가장 민감한 값을 가림), 흉내 낸 객체는 원격 문맥이 아니다', async () => {
  const ctx = remoteContext({ uid: 'u1', orgId: ORG, session: async () => null, jwt: async () => null });
  assert.equal(await audienceOf(null, ctx, 'u1'), 'org');
  const fake = { kind: 'msgr', uid: 'u1', orgId: ORG, channelKind: 'dm', session: async () => null };
  assert.notEqual(await audienceOf({ from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }) }, fake, 'u1'), 'org', '모양만 같은 객체는 판정이 다르다');
});

test('runSpec — 요청마다 세션을 ctx로 넘긴다(전역 상태 없음)', async () => {
  const a = fakeSession({ rpc: { office_task_list: [{ id: 't1', title: 'A의 일', status: 'todo', assignee: 'u1', created_by: 'u1' }] } });
  const b = fakeSession({ rpc: { office_task_list: [{ id: 't2', title: 'B의 일', status: 'todo', assignee: 'u1', created_by: 'u1' }] } });
  const spec = remoteSpecs().find((s) => s.name === 'office_work');
  const [ra, rb] = await Promise.all([runSpec(spec, { action: 'tasks' }, { c: a.c, org: ORG }), runSpec(spec, { action: 'tasks' }, { c: b.c, org: ORG })]);
  assert.match(ra, /A의 일/); assert.doesNotMatch(ra, /B의 일/);
  assert.match(rb, /B의 일/); assert.doesNotMatch(rb, /A의 일/);
});

const rpcReq = (body, token = TOK) => new Request('https://office.test/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('HTTP — 토큰이 없거나 틀리면 401과 보호 자원 메타데이터 주소', async () => {
  for (const token of [null, 'x'.repeat(30)]) {
    const r = await handle(rpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token), { sessionFor: async () => null });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/office\.test\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
  }
});

test('HTTP — 초기화·도구 목록·도구 호출이 상태 없이 JSON으로 돈다', async () => {
  const { c } = fakeSession({ rpc: { office_agent_action_add: 'aaaaaaaa-0000-4000-8000-000000000002' } });
  const deps = { sessionFor: async (t) => (t === TOK ? c : null) };
  const init = await handle(rpcReq({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'argo-connector', version: '1' } } }), deps);
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name, 'argo-office');
  const list = await handle(rpcReq({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), deps);
  assert.ok((await list.json()).result.tools.some((t) => t.name === 'office_work'));
  const call = await handle(rpcReq({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'office_work', arguments: { action: 'task_add', title: 'HTTP 시험' } } }), deps);
  assert.match((await call.json()).result.content[0].text, /대기 변경/);
});

test('보호 자원 메타데이터 — 자원 주소와 Supabase Auth 인증 서버', async () => {
  const old = process.env.VITE_SUPABASE_URL; process.env.VITE_SUPABASE_URL = 'https://ref.supabase.test';
  try {
    const d = await resourceGet(new Request('https://office.test/.well-known/oauth-protected-resource/api/mcp')).json();
    assert.equal(d.resource, 'https://office.test/api/mcp');
    assert.deepEqual(d.authorization_servers, ['https://ref.supabase.test/auth/v1']);
  } finally { if (old === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = old; }
});

const actReq = (body, token = TOK) => new Request('https://office.test/api/agent/actions', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const ID = 'bbbbbbbb-0000-4000-8000-000000000001';

test('[실행] — 잡은 행의 도구·인자·조직으로 한 번 실행하고 결과를 적는다', async () => {
  const row = { id: ID, tool: 'office_work', action: 'task_add', args: { action: 'task_add', title: '견적 회신' }, org_id: ORG, source: 'Argo' };
  const { c, calls } = fakeSession({ rpc: { office_agent_action_claim: row, office_agent_action_finish: true } });
  const ran = [];
  const r = await run(actReq({ id: ID }), { sessionFor: async () => c, runSpec: async (spec, args, o) => { ran.push({ name: spec.name, args, org: o.org }); return '할 일을 만들었다'; } });
  assert.equal(r.status, 200);
  assert.deepEqual(ran, [{ name: 'office_work', args: row.args, org: ORG }]);
  assert.deepEqual(calls.map((x) => x.fn), ['office_agent_action_claim', 'office_agent_action_finish']);
  assert.deepEqual(calls[1].args, { p_id: ID, p_ok: true, p_result: '할 일을 만들었다' });
});

test('[실행] — 대기 중이 아니면(이미 처리·남의 행) 409, 로그인 없으면 401, 막은 동작은 실패로 적고 실행하지 않는다', async () => {
  const none = fakeSession({ rpc: { office_agent_action_claim: null } });
  assert.equal((await run(actReq({ id: ID }), { sessionFor: async () => none.c })).status, 409);
  assert.equal((await run(actReq({ id: ID }, null), { sessionFor: async () => null })).status, 401);
  assert.equal((await run(actReq({ id: 'x' }), { sessionFor: async () => none.c })).status, 400);
  const blocked = fakeSession({ rpc: { office_agent_action_claim: { id: ID, tool: 'calendar', action: 'delete', args: { action: 'delete', id: 'e1' }, org_id: null, source: 'x' }, office_agent_action_finish: true } });
  const ran = [];
  const r = await run(actReq({ id: ID }), { sessionFor: async () => blocked.c, runSpec: async () => { ran.push(1); return 'x'; } });
  assert.equal((await r.json()).status, 'failed');
  assert.equal(ran.length, 0);
  assert.equal(blocked.calls[1].args.p_ok, false);
});

test('[실행] — 처리기가 던지면 실패로 적는다', async () => {
  const { c, calls } = fakeSession({ rpc: { office_agent_action_claim: { id: ID, tool: 'office_work', action: 'task_add', args: { action: 'task_add', title: 'x' }, org_id: ORG, source: 'x' }, office_agent_action_finish: true } });
  const r = await run(actReq({ id: ID }), { sessionFor: async () => c, runSpec: async () => { throw new Error('rpc down'); } });
  assert.equal((await r.json()).status, 'failed');
  assert.equal(calls[1].args.p_ok, false);
  assert.match(calls[1].args.p_result, /rpc down/);
});

// 검수 2 HIGH-1 · 총괄 결정(2026-10-13) — 토큰 종류: 원격 MCP는 허용 목록 OAuth 클라이언트 토큰만, [실행]은 오피스 화면 세션(client_id 없음)만
import { tokenAllowed, clientIdOf, sessionFor } from '../server/agent/auth.js';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig_${'x'.repeat(20)}`;

test('토큰 종류 — 화면 세션은 [실행]만, 허용 목록 클라이언트 토큰은 MCP만, 목록 밖 클라이언트는 둘 다 거절', () => {
  const old = process.env.OFFICE_MCP_CLIENTS; process.env.OFFICE_MCP_CLIENTS = 'argo-desktop, claude-code';
  try {
    const user = jwt({ sub: 'u1', aud: 'authenticated' }), argo = jwt({ sub: 'u1', client_id: 'argo-desktop' }), rogue = jwt({ sub: 'u1', client_id: 'rogue-app' });
    assert.equal(clientIdOf(argo), 'argo-desktop'); assert.equal(clientIdOf(user), null); assert.equal(clientIdOf('not-a-jwt'), null);
    assert.equal(tokenAllowed(user, 'user'), true); assert.equal(tokenAllowed(user, 'mcp'), false, '화면 세션으로 MCP를 쓰지 않는다');
    assert.equal(tokenAllowed(argo, 'mcp'), true); assert.equal(tokenAllowed(argo, 'user'), false, 'OAuth 클라이언트 토큰은 [실행] 못 한다');
    assert.equal(tokenAllowed(rogue, 'mcp'), false, '허용 목록 밖'); assert.equal(tokenAllowed(rogue, 'user'), false);
    assert.equal(tokenAllowed(argo, undefined), false, '종류를 안 주면 거절');
  } finally { if (old === undefined) delete process.env.OFFICE_MCP_CLIENTS; else process.env.OFFICE_MCP_CLIENTS = old; }
});

test('토큰 종류가 맞지 않으면 사용자 확인(/auth/v1/user)도 부르지 않는다', async () => {
  const saved = { u: process.env.VITE_SUPABASE_URL, k: process.env.VITE_SUPABASE_ANON_KEY, c: process.env.OFFICE_MCP_CLIENTS };
  Object.assign(process.env, { VITE_SUPABASE_URL: 'https://ref.supabase.test', VITE_SUPABASE_ANON_KEY: 'anon', OFFICE_MCP_CLIENTS: 'argo-desktop' });
  try {
    let calls = 0; const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ id: 'u1' })); };
    assert.equal(await sessionFor(jwt({ sub: 'u1', client_id: 'argo-desktop' }), { kind: 'user', fetchImpl }), null);
    assert.equal(await sessionFor(jwt({ sub: 'u1' }), { kind: 'mcp', fetchImpl }), null);
    assert.equal(calls, 0);
    assert.equal((await sessionFor(jwt({ sub: 'u1', client_id: 'argo-desktop' }), { kind: 'mcp', fetchImpl })).clientId, 'argo-desktop');
    assert.equal(calls, 1);
  } finally { for (const [k, v] of [['VITE_SUPABASE_URL', saved.u], ['VITE_SUPABASE_ANON_KEY', saved.k], ['OFFICE_MCP_CLIENTS', saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('HTTP 경로가 묻는 토큰 종류 — MCP는 mcp, [실행]은 user', async () => {
  const kinds = [];
  const spy = async (t, o) => { kinds.push(o?.kind); return null; };
  await handle(rpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { sessionFor: spy });
  await run(actReq({ id: ID }), { sessionFor: spy });
  assert.deepEqual(kinds, ['mcp', 'user']);
});

// 검수 2 MEDIUM-1 — 원격 읽기는 거래처 계좌·사업자번호를 회사 계좌와 같은 기준으로 가린다. 사람이 [실행]한 대기 변경은 주인 자리
test('거래처 — 원격 읽기는 계좌·사업자번호를 가리고, 승인된 실행 문맥에서는 보인다', async () => {
  const customer = { id: 'cu1', name: '한빛', account: '국민 123-456', biz_no: '123-45-67890', redacted: [] };
  const { c } = fakeSession({ rpc: { office_business_read: { customers: [customer], orders: [], items: [], events: [] } } });
  const spec = remoteSpecs().find((s) => s.name === 'office_deals');
  const plain = await runSpec(spec, { action: 'customers', id: 'cu1' }, { c, org: ORG });
  assert.doesNotMatch(plain, /123-456|123-45-67890/, plain);
  const approved = await runSpec(spec, { action: 'customers', id: 'cu1' }, { c, org: ORG, approved: true });
  assert.match(approved, /123-456/, approved);
});
