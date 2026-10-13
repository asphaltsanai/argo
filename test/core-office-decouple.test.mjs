// 본체에서 오피스 결합 제거(2026-10-13 오피스 독립 앱 분리 — 유건 지시). 에이전트는 오피스를 원격 MCP 커넥터(apps/office/api/mcp.js)로 쓴다.
// 이 파일이 잠그는 것: ① 턴 종류별 크루 도구 목록 = 제거 전 목록에서 오피스 도구(calendar·office·office_*)만 빠진 것(다른 도구 회귀 0)
// ② 옛 패널 표지(officePanel·officePanelSolo·officePanelChain)가 남아 있어도 위임·쪽지·예약·긴 작업이 일반 메신저 턴과 똑같다(패널 전용 의미 없음)
// ③ 오피스 원격 MCP가 커넥터 카탈로그에 있다(자동 등록 OAuth — 고정 client_id 없음). 라이브 DB 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-office-decouple-')); // import보다 먼저(레포 관례)
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { makeCrewServer } = await import('../src/chat.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { CONNECTOR_CATALOG, CONNECTOR_CATALOG_EN, connectorMode } = await import('../src/market.mjs');

const WS = 'decouple';
await createCompany(WS, '분리사', 'captain');

async function tools(ctx, colleagues = []) {
  const srv = makeCrewServer(WS, 'ay', '에이', colleagues, 0, [], ctx, 'ko');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.instance.connect(st);
  const c = new Client({ name: 't', version: '1' }); await c.connect(ct);
  try { return { names: (await c.listTools()).tools.map((t) => t.name).sort(), call: async (name, args) => (await c.callTool({ name, arguments: args })).content[0].text }; }
  finally { /* 호출이 끝난 뒤 닫는다 — 아래 close */ }
}
const msgr = (extra = {}) => ({ kind: 'msgr', uid: 'u', origin: 'u', channelKind: 'dm', channelId: 'c', crewId: 'k', orgId: 'o', handoffs: [], peers: [], ...extra });

// 제거 전 목록(origin/main f3044799에서 같은 맥락으로 찍은 값)에서 오피스 도구만 뺀 것
const BASE = ['argo_help', 'argo_settings', 'argo_status', 'cancel_routine', 'goal_heartbeat', 'hire_crew', 'list_routines', 'request_approval', 'request_tool_install', 'schedule_task', 'start_long_task', 'update_profile'];
const OFFICE = /^(calendar|office|office_.+)$/;

test('턴 종류별 크루 도구 — 제거 전 목록에서 오피스 도구만 빠진다(데스크톱·주인 1:1·조직 채널·개인 공간)', async () => {
  const cases = {
    desktop: [null, BASE],
    dm: [msgr(), [...BASE, 'propose_org_doc'].sort()],
    channel: [msgr({ channelKind: 'public' }), [...BASE, 'propose_org_doc'].sort()],
    personal: [msgr({ orgId: null }), [...BASE, 'propose_org_doc'].sort()],
  };
  for (const [k, [ctx, want]] of Object.entries(cases)) {
    const { names } = await tools(ctx);
    assert.deepEqual(names, want, k);
    assert.ok(!names.some((n) => OFFICE.test(n)), `${k}: 오피스 도구가 남았다`);
  }
});

test('옛 패널 표지가 있어도 일반 메신저 턴과 같다 — 쪽지 도구가 그대로, 예약·긴 작업을 거절하지 않는다', async () => {
  const peer = { id: 'p2', slug: 'bee', display_name: '비', owner_user_id: 'u', ws_id: WS };
  const plain = await tools(msgr({ peers: [peer] }), [{ slug: 'bee', name: '비' }]);
  const panel = await tools(msgr({ peers: [peer], officePanel: true, officePanelSolo: true, proposals: [] }), [{ slug: 'bee', name: '비' }]);
  assert.deepEqual(panel.names, plain.names, '패널 표지가 도구 목록을 바꾸지 않는다');
  for (const ctx of [msgr({ officePanel: true, proposals: [] }), msgr({ officePanelChain: true })]) {
    const t = await tools(ctx);
    const out = await t.call('start_long_task', { title: '수집', prompt: 'x' });
    assert.doesNotMatch(out, /오피스 에이전트 창/, '패널 거절 문구가 없다');
  }
});

test('오피스 원격 MCP 커넥터 — ko·en 같은 id·url·client_id, 운영에 미리 등록한 공개 클라이언트(DCR 안 씀), https', () => {
  const ko = CONNECTOR_CATALOG.find((c) => c.id === 'argo-office');
  const en = CONNECTOR_CATALOG_EN.find((c) => c.id === 'argo-office');
  assert.ok(ko && en);
  assert.equal(ko.url, en.url);
  assert.match(ko.url, /^https:\/\/[^/]+\/api\/mcp$/);
  assert.equal(ko.oauth?.client_id, '5f13cfbb-8ba1-4d55-993c-496f3134bc44', '운영 Supabase에 등록한 Argo 공개 클라이언트');
  assert.deepEqual(en.oauth, ko.oauth, '영어 회사도 같은 클라이언트');
  assert.equal(ko.oauth.client_secret_env, undefined, '공개 클라이언트(PKCE) — 비밀 없음');
  assert.equal(connectorMode(ko), 'fixed', 'DCR을 시도하지 않는다');
  assert.equal(ko.redirect_port, 47317);
  assert.equal(en.redirect_port, 47317);
});

test('지운 파일 — 오피스 크루 도구·패널 관문·로컬 오피스 MCP가 본체에 없다', () => {
  for (const f of ['gateway/office-tools.mjs', 'gateway/office-work.mjs', 'gateway/office-deals.mjs', 'gateway/office-company.mjs', 'gateway/office-files.mjs', 'gateway/office-calendar.mjs',
    'gateway/office-mail.mjs', 'gateway/office-briefing.mjs', 'gateway/office-audience.mjs', 'gateway/office-proposals.mjs', 'gateway/office-route.mjs', 'gateway/office-steps.mjs',
    'office-confirm.mjs', 'office-tools-cli.mjs', 'office-mcp.mjs', 'panel-children.mjs']) assert.ok(!existsSync(new URL(`../src/${f}`, import.meta.url)), f);
});

// 운영 Supabase의 Site URL(localhost:3001) + Authorization Path(/oauth/consent) → 본체가 오피스 동의 화면으로 넘긴다
test('OAuth 동의 넘김 — 쿼리를 그대로 붙여 오피스 /oauth/consent로, 목적지는 고정', async () => {
  const { officeConsentTarget } = await import('../app/oauth-consent.mjs');
  const { OFFICE_CONSENT_URL } = await import('../app/oauth-consent.mjs');
  const ko = CONNECTOR_CATALOG.find((c) => c.id === 'argo-office');
  assert.equal(new URL(OFFICE_CONSENT_URL).origin, new URL(ko.url).origin, '커넥터와 같은 오피스');
  assert.equal(officeConsentTarget('http://localhost:3001/oauth/consent?authorization_id=abc-123'),
    'https://argo-office.vercel.app/oauth/consent?authorization_id=abc-123');
  assert.equal(officeConsentTarget('http://localhost:3001/oauth/consent?authorization_id=a%2Fb&x=1'),
    'https://argo-office.vercel.app/oauth/consent?authorization_id=a%2Fb&x=1', '인코딩 그대로');
  assert.equal(officeConsentTarget('http://localhost:3001/oauth/consent'), 'https://argo-office.vercel.app/oauth/consent');
  // 경로·호스트를 쿼리에 실어도 목적지는 바뀌지 않는다(열린 리디렉트 아님)
  assert.match(officeConsentTarget('http://localhost:3001/oauth/consent?next=https://evil.example/'), /^https:\/\/argo-office\.vercel\.app\/oauth\/consent\?/);
});
