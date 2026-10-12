// 메신저에 에이전트가 하나도 안 나타날 때(내 행 0개) 설정 카드가 이유와 할 일을 한 줄로 알려 준다(2026-10-13 사례: Windows 본체 + Android 메신저,
// 무료·조직 없음 — 카드는 "첫 응답을 기다리는 중"·"파견된 에이전트 없음"만 보였고 운영 조회로는 msgr_crews 0행·심박 0행이었다).
// 새 본체가 브리지를 스스로 켜는 조건(src/gateway/msgr.mjs autoEnableMsgr)은 "회사 소유자 = 로그인 계정" 그리고 "조직 멤버이거나 이 계정으로 메신저에
// 로그인한 적 있음(msgr_profiles)"이다. 본체가 메신저와 다른 계정으로 로그인돼 있으면 이 조건이 영영 맞지 않아 행이 생기지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msgrSetupReason } from '../app/c/[ws]/settings/msgr-card.mjs';
import { zeroRowsReconnect } from '../app/api/companies/[ws]/msgr/setup-facts.mjs';

const st = (setup, extra = {}) => ({ signedIn: true, email: 'me@example.com', orgs: [], crews: [], personal: [], setup, ...extra });

test('행이 0개일 때 이유: 회사 소유 계정 아님 → 메신저를 쓴 적 없는 계정 → 연결 준비 중', () => {
  assert.deepEqual(msgrSetupReason({ st: st({ owner: false, profile: false, bridge: false }) }), { reason: 'owner', action: 'login' }, '소유자 불일치가 먼저 — 계정을 바꿔야 나머지가 의미 있다');
  assert.deepEqual(msgrSetupReason({ st: st({ owner: true, profile: false, bridge: false }) }), { reason: 'account', action: 'login' }, '사례의 원인 후보 1(다른 계정)');
  assert.deepEqual(msgrSetupReason({ st: st({ owner: true, profile: true, bridge: false }) }), { reason: 'pending', action: 'connect' });
  assert.deepEqual(msgrSetupReason({ st: st({ owner: true, profile: true, bridge: true }) }), { reason: 'pending', action: 'connect' });
});

test('조직 멤버면 메신저 프로필을 묻지 않고 연결 준비 중으로 본다(자동 켜기와 같은 조건)', () => {
  assert.deepEqual(msgrSetupReason({ st: st({ owner: true, profile: null, bridge: false }, { orgs: [{ id: 'o1' }] }) }), { reason: 'pending', action: 'connect' });
});

test('프로필 조회를 못 했으면(null) 계정 문제로 단정하지 않는다', () => {
  assert.deepEqual(msgrSetupReason({ st: st({ owner: true, profile: null, bridge: false }) }), { reason: 'pending', action: 'connect' });
});

test('이유 줄이 없는 경우: 로드 전·로그인 안 됨(기존 문구)·행이 있음(setup 없음)', () => {
  assert.equal(msgrSetupReason({ st: null }), null);
  assert.equal(msgrSetupReason({ st: { signedIn: false } }), null);
  assert.equal(msgrSetupReason({ st: st(null) }), null);
  assert.equal(msgrSetupReason({ st: st(undefined) }), null);
});

test('행이 0개인 계정의 "지금 연결" — 메신저를 쓰는 계정이면 브리지를 켜고, 아니면 계정 확인으로 돌려보낸다', () => {
  assert.equal(zeroRowsReconnect({ owner: true, orgCount: 0, profile: true }), 'enable');
  assert.equal(zeroRowsReconnect({ owner: true, orgCount: 2, profile: false }), 'enable', '조직 멤버');
  assert.equal(zeroRowsReconnect({ owner: true, orgCount: 0, profile: false }), 'account');
  assert.equal(zeroRowsReconnect({ owner: true, orgCount: 0, profile: null }), 'account', '조회 실패면 켜지 않는다(자동 켜기와 같은 쪽으로 보수적)');
  assert.equal(zeroRowsReconnect({ owner: false, orgCount: 2, profile: true }), 'owner');
});

test('이유 상자가 있어도 브리지가 켜졌고 막힌 원인이 있으면 실행기 상태를 함께 보인다(#979 검수 2 MEDIUM-2)', async () => {
  const { msgrRuntimeBesideSetup } = await import('../app/c/[ws]/settings/msgr-card.mjs');
  const why = { reason: 'pending', action: 'connect' };
  assert.equal(msgrRuntimeBesideSetup({ st: st({ owner: true, profile: true, bridge: false }) }), true, '이유 상자가 없으면 종전대로');
  for (const state of ['login', 'owner', 'company', 'offline', 'reconnecting']) {
    assert.equal(msgrRuntimeBesideSetup({ st: st({ owner: true, profile: true, bridge: true }, { runtime: { state } }), setupWhy: why }), true, state);
  }
  assert.equal(msgrRuntimeBesideSetup({ st: st({ owner: true, profile: true, bridge: true }, { runtime: { state: 'waiting' } }), setupWhy: why }), false, 'waiting은 이유 상자가 대신 말한다');
  assert.equal(msgrRuntimeBesideSetup({ st: st({ owner: true, profile: false, bridge: false }, { runtime: { state: 'offline' } }), setupWhy: why }), false, '브리지가 꺼져 있으면 실행기 상태는 이 상황과 무관(옛 값)');
});
