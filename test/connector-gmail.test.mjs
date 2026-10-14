// Gmail 커넥터 등재(유건 지시 2026-10-14, 0.1.108) — 구글 캘린더와 같은 방식: 구글 공식 원격 MCP, 고정 client_id + client_secret_env.
// 여기 적힌 값은 전부 2026-10-14 무인증 실측이다(gmailmcp.googleapis.com/mcp/v1 tools/list·도구별 PRM) — 추측으로 고치면 연결이 조용히 깨진다.
//  ① 카탈로그 — ko·en 같은 id·url·scopes·oauth, 고정 모드, secret은 이름만
//  ② scopes — 23개 도구 전부를 덮는 좁은 쪽 하나(gmail.modify). mail.google.com(영구 삭제·발송 전권)은 쓰지 않는다
//  ③ 결재 — 쓰기 17개(readOnlyHint=false)는 결재 대상, 읽기 6개는 바로. 서버 annotations가 비어도 보완 목록으로 잡힌다
//  ④ 손님 턴 — Gmail도 연결 여부와 상관없이 guest_blocked(러너 무관 단일 지점)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-conn-gmail-')); // import보다 먼저
const { CONNECTOR_CATALOG, CONNECTOR_CATALOG_EN, connectorMode, connectorCatalogFor } = await import('../src/market.mjs');
const { connectorToolNeedsApproval, callConnectorTool } = await import('../src/connectors.mjs');
const { createCompany } = await import('../src/workspace.mjs');

// 실측 tools/list(2026-10-14) — 이름과 readOnlyHint만. 서버가 도구를 바꾸면 이 표와 카탈로그를 같이 갱신한다.
const GMAIL_TOOLS = [
  ['create_draft', false], ['list_drafts', true], ['get_draft', true], ['get_thread', true], ['get_message', true], ['search_threads', true],
  ['label_thread', false], ['unlabel_thread', false], ['apply_sensitive_thread_label', false], ['trash_thread', false], ['untrash_thread', false],
  ['mark_thread_spam', false], ['unmark_thread_spam', false], ['list_labels', true], ['label_message', false], ['update_message_labels', false],
  ['unlabel_message', false], ['apply_sensitive_message_label', false], ['trash_message', false], ['untrash_message', false],
  ['mark_message_spam', false], ['unmark_message_spam', false], ['create_label', false],
].map(([name, readOnlyHint]) => ({ name, annotations: { readOnlyHint } }));
const WRITES = GMAIL_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
const READS = GMAIL_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);

const ko = CONNECTOR_CATALOG.find((c) => c.id === 'gmail');
const en = CONNECTOR_CATALOG_EN.find((c) => c.id === 'gmail');

test('① 카탈로그 — ko·en 짝(같은 id·url·scopes·oauth), 고정 모드, secret은 환경변수 이름만', () => {
  assert.ok(ko && en, 'Gmail이 ko·en 카탈로그에 모두 있어야 한다');
  assert.equal(ko.url, 'https://gmailmcp.googleapis.com/mcp/v1', '경로 /mcp/v1이 계약이다(캘린더와 같음)');
  for (const k of ['url', 'scopes', 'oauth', 'dangerous']) assert.deepEqual(en[k], ko[k], `en 미러의 ${k}가 ko와 다르다`);
  assert.equal(connectorMode(ko), 'fixed', 'DCR 미지원(구글) — 고정 모드여야 연결된다');
  const cal = CONNECTOR_CATALOG.find((c) => c.id === 'google-calendar');
  assert.deepEqual(ko.oauth, cal.oauth, '캘린더와 같은 Argo 구글 OAuth 클라이언트');
  assert.equal(ko.oauth.client_secret, undefined, '소스에 secret 값이 실렸다 — 이 레포는 public이다');
  assert.equal(ko.name, 'Gmail'); assert.equal(en.name, 'Gmail');
  assert.doesNotMatch(en.note, /[가-힣]/, 'en 안내에 한국어');
  assert.deepEqual(connectorCatalogFor('en').map((c) => c.id), connectorCatalogFor('ko').map((c) => c.id));
});

test('② scopes — 23개 도구 전부를 덮는 좁은 하나(gmail.modify), 전권 mail.google.com은 쓰지 않는다', () => {
  assert.deepEqual(ko.scopes, ['https://www.googleapis.com/auth/gmail.modify']);
  assert.ok(!ko.scopes.includes('https://mail.google.com/'));
  assert.equal(GMAIL_TOOLS.length, 23);
  assert.ok(!GMAIL_TOOLS.some((t) => /send/.test(t.name)), '실측 시점에 발송 도구가 없다 — 생기면 안내 문구(보내기 없음)를 고친다');
});

test('③ 결재 — 쓰기 17개는 결재, 읽기 6개는 바로. 서버 annotations가 비어도 보완 목록이 쓰기를 잡는다', () => {
  assert.equal(WRITES.length, 17); assert.equal(READS.length, 6);
  assert.deepEqual([...ko.dangerous].sort(), [...WRITES].sort(), '보완 목록이 실측 쓰기 도구와 어긋난다');
  for (const n of WRITES) {
    assert.equal(connectorToolNeedsApproval(n, GMAIL_TOOLS, ko.dangerous), true, `${n} — annotations로`);
    assert.equal(connectorToolNeedsApproval(n, [], ko.dangerous), true, `${n} — annotations가 비어도 보완 목록으로`);
  }
  for (const n of READS) assert.equal(connectorToolNeedsApproval(n, GMAIL_TOOLS, ko.dangerous), false, `${n} — 읽기는 바로`);
});

test('④ 손님 턴 — Gmail 도구도 guest_blocked(연결 여부보다 먼저 막힌다)', async () => {
  const WS = 'co-gmail-guest';
  await createCompany(WS, '지메일 손님 테스트사', 'captain');
  const guest = { kind: 'msgr', uid: 'owner-uid', origin: 'someone-else' };
  for (const tool of ['search_threads', 'create_draft', 'trash_thread']) {
    const r = await callConnectorTool(WS, 'gmail', tool, {}, { slug: 'captain', mirrorCtx: guest });
    assert.equal(r.error, 'guest_blocked', `${tool} — 손님 턴인데 막히지 않았다`);
  }
  const en = await callConnectorTool(WS, 'gmail', 'search_threads', {}, { slug: 'captain', mirrorCtx: guest, lang: 'en' });
  assert.equal(en.error, 'guest_blocked');
});
