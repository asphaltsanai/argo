// 메신저에 에이전트가 하나도 없을 때(내 행 0개) 설정 카드 라우트(app/api/companies/[ws]/msgr/route.js)를 실제로 돌린다 — 세션·회사 설정·DB만 대역(helpers/msgr-route-harness.mjs).
// GET은 이유를 고를 사실(setup)과 이 기기가 로그인한 계정(email)을 주고, [지금 연결]은 메신저를 쓰는 계정이면 자동 켜기(10분)를 기다리지 않고 브리지를 켠다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-setup-'));
const HARNESS = fileURLToPath(new URL('./helpers/msgr-route-harness.mjs', import.meta.url));
const ORG = '22222222-2222-2222-2222-222222222222';
function run(input) {
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', HARNESS], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ARGO_ROOT: ROOT, ARGO_MSGR_HARNESS: JSON.stringify(input) },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('GET — 행 0개면 이유를 고를 사실을 준다: 메신저를 쓴 적 없는 계정 / 쓰는 계정 / 소유자 아님 / 조회 실패', () => {
  const none = run({ method: 'GET', crews: [], agents: ['a'], enabled: false, profile: false });
  assert.equal(none.body.email, 'me@example.com', '이 기기가 로그인한 계정');
  assert.deepEqual(none.body.setup, { owner: true, profile: false, bridge: false });
  assert.deepEqual(run({ method: 'GET', crews: [], agents: ['a'], enabled: false, profile: true }).body.setup, { owner: true, profile: true, bridge: false });
  assert.equal(run({ method: 'GET', crews: [], agents: ['a'], ownerId: 'someone-else', profile: true }).body.setup.owner, false);
  assert.equal(run({ method: 'GET', crews: [], agents: ['a'], profile: 'fail' }).body.setup.profile, null, '조회 실패는 null — 계정 문제로 단정하지 않는다');
});

test('GET — 행이 있으면 setup이 없고 메신저 프로필을 묻지 않는다(카드 8초 폴에 조회를 늘리지 않는다)', () => {
  const out = run({ method: 'GET', crews: [{ slug: 'a', status: 'active', org_id: null }], agents: ['a'] });
  assert.equal(out.body.setup, null);
  assert.ok(!out.log.includes('profile?'), `프로필 조회 0건: ${out.log}`);
  const avail = run({ method: 'GET', crews: [{ slug: 'a', status: 'available', org_id: null }], agents: ['a'] });
  assert.equal(avail.body.setup, null, '사람이 해제한 행만 있어도 "행 0개"가 아니다(종전 줄 문구가 설명한다)');
});

test('[지금 연결] — 행 0개 + 메신저를 쓰는 계정이면 꺼진 브리지를 켜고 "다시 연결하는 중"', () => {
  const out = run({ crews: [], agents: ['a'], enabled: false, profile: true, body: { reconnect: true } });
  assert.equal(out.body.runtime.state, 'reconnecting', JSON.stringify(out));
  assert.equal(out.enabled, true);
});

test('[지금 연결] — 행 0개 + 메신저를 쓴 적 없는 계정(또는 조회 실패)이면 켜지 않고 계정 확인으로', () => {
  for (const profile of [false, 'fail']) {
    const out = run({ crews: [], agents: ['a'], enabled: false, profile, body: { reconnect: true } });
    assert.equal(out.body.runtime.state, 'account', JSON.stringify(out));
    assert.equal(out.enabled, false);
  }
});

test('[지금 연결] — 소유자가 아니면 종전처럼 owner(브리지 값을 쓰지 않는다)', () => {
  const out = run({ crews: [], agents: ['a'], enabled: false, ownerId: 'someone-else', body: { reconnect: true } });
  assert.equal(out.body.runtime.state, 'owner');
  assert.equal(out.enabled, false);
});

test('[지금 연결] — 해제된 행만 있으면 종전처럼 noCrews(행 0개 경로를 타지 않는다)', () => {
  const out = run({ crews: [{ slug: 'a', status: 'available', org_id: ORG }], enabled: false, body: { reconnect: true } });
  assert.equal(out.body.runtime.state, 'noCrews');
  assert.equal(out.enabled, false);
});

test('회사 노드(nodeOrgId)는 대상 밖 — GET에 setup이 없고 프로필을 묻지 않으며, [지금 연결]은 종전대로 noCrews(브리지 값을 쓰지 않는다)', () => {
  const get = run({ method: 'GET', crews: [], agents: ['a'], enabled: false, nodeOrgId: ORG });
  assert.equal(get.body.setup, null, '자동 켜기·미러가 건너뛰어 행이 늘 0개 — "연결 준비 중"이 영영 남지 않게(#979 검수 2 MEDIUM-1)');
  assert.ok(!get.log.includes('profile?'), `프로필 조회 0건: ${get.log}`);
  const post = run({ crews: [], agents: ['a'], enabled: false, nodeOrgId: ORG, body: { reconnect: true } });
  assert.equal(post.body.runtime.state, 'noCrews');
  assert.equal(post.enabled, false);
});
