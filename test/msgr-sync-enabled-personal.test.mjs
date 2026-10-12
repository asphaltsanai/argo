// 조직 없는(개인 공간만 쓰는) 계정의 메신저 브리지(company.json.msgr.enabled) — 설정 카드가 끄지 않는다(2026-10-12 재현, 0.1.104 발행 전).
// 결함: route.js syncEnabled가 조직 등록 행만 세어, 개인 공간 [유지할 에이전트 고르기](#966)가 브리지를 껐다. 에이전트가 4명 이하로 모두 연결돼 있으면
//   자동 켜기(autoEnableMsgr)도 '크루 행이 있고 멈춘 행이 없는' 계정이라 다시 켜지 않았다 → 개인 공간 에이전트가 답하지 않는다.
// 잠그는 것(실제 라우트를 자식 프로세스에서 돌린다 — helpers/msgr-route-harness.mjs, 세션·회사 설정·DB만 대역):
//   ① 개인만·5명: 고르기 뒤에도 브리지 켜짐(응답 crews는 종전대로 조직 등록만)  ② 개인만·4명(3 연결 + 1 멈춤에서 4명 고르기): 켜짐, 자동 켜기에 기대지 않는다
//   ③ 멈춘 개인 행만 남으면 이 앱이 최소 버전 이상일 때만 켠다(#945 MEDIUM-2 규칙을 개인 행에도 같게) — 옛 앱이면 끔, 새 앱이면 켬
//   ③-3 옛 앱의 고르기는 서버가 거절하고(msgr_app_update_required) 브리지 값을 쓰지 않는다
//   ④ 조직 등록을 모두 해제했고 연결된 개인 행이 없으면(없음·available·detached) 끈다(종전 그대로)  ⑤ 연결된 개인 행이 있으면 켜 둔다(개인 공간도 브리지가 답한다)
//   ⑥ 조직 등록 연결은 켠다(종전 그대로)  ⑦ 개인 공간 [연결]은 종전처럼 브리지를 건드리지 않는다
//   ⑧ [다시 연결](분리 검수 MEDIUM-1): 조직 없는 계정의 꺼진 브리지를 개인 행으로 되살린다, 연결된 행이 없으면 종전처럼 noCrews
//   ⑨ 멈춘 행만인데 최소 버전 조회(msgr_my_agent_pause)가 실패하면 판정하지 않는다 — 브리지 값 그대로, 쓰기 0(검수 1 LOW-1)
//   ⑧-a 멈춘 행만 + 옛 앱이면 꺼 두고 업데이트 안내로 답한다(재검수 LOW-A)  ⑧-b 멈춘 행만 + 새 앱이면 되살린다  ⑧-c 소유자가 아닌 기기는 쓰지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-syncen-'));
const HARNESS = fileURLToPath(new URL('./helpers/msgr-route-harness.mjs', import.meta.url));
const ORG = '22222222-2222-2222-2222-222222222222';
function run(input) {
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', HARNESS], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ARGO_ROOT: ROOT, ARGO_MSGR_HARNESS: JSON.stringify(input) },
  });
  const last = r.stdout.trim().split('\n').pop();
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(last);
}
const personal = (n, status = 'active') => ['a', 'b', 'c', 'd', 'e'].slice(0, n).map((slug) => ({ slug, status, org_id: null }));
const keepAll = (n) => ({ keep: ['a', 'b', 'c', 'd', 'e'].slice(0, Math.min(n, 4)).map((s) => `ws1:${s}`), personal: true });

const orgDel = (personalRows, extra = {}) => run({ method: 'DELETE', crews: [{ slug: 'z', status: 'active', org_id: ORG }, ...personalRows], body: { orgId: ORG, slug: 'z' }, ...extra });

test('① 개인 공간만·에이전트 5명 — [유지할 에이전트 고르기] 뒤에도 브리지가 켜져 있다', () => {
  const out = run({ crews: [...personal(4), { slug: 'e', status: 'paused', org_id: null }], body: { keep: ['ws1:a', 'ws1:b', 'ws1:c', 'ws1:e'], personal: true } });
  assert.equal(out.status, 200);
  assert.equal(out.enabled, true, JSON.stringify(out));
  assert.deepEqual(out.rows, ['a:active', 'b:active', 'c:active', 'd:paused', 'e:active']);
  assert.deepEqual(out.body.crews, [], '돌려주는 crews는 조직 등록만(개인 행을 섞지 않는다)');
});

test('② 개인 공간만·에이전트 4명(3명 연결 + 1명 멈춤 → 4명 고르기) — 브리지가 켜져 있고, 한 번도 끄지 않는다', () => {
  const out = run({ crews: [...personal(3), { slug: 'd', status: 'paused', org_id: null }], pauseReason: 'room', body: { keep: ['ws1:a', 'ws1:b', 'ws1:c', 'ws1:d'], personal: true }, auto: true });
  assert.equal(out.status, 200);
  assert.deepEqual(out.rows, ['a:active', 'b:active', 'c:active', 'd:active']);
  assert.equal(out.enabled, true, JSON.stringify(out));
  assert.ok(!out.log.includes('enabled=false'), `한 번도 끄지 않는다: ${out.log}`);
});

test('③ 멈춘 개인 행만 남으면 — 옛 앱(최소 버전 미만)이면 끄고, 새 앱이면 켠다', () => {
  const old = orgDel(personal(2, 'paused'), { pauseReason: 'app', minApp: 'old' });
  assert.deepEqual(old.rows, ['a:paused', 'b:paused']);
  assert.equal(old.enabled, false, JSON.stringify(old));
  const fresh = orgDel(personal(2, 'paused'), { pauseReason: 'off' });
  assert.equal(fresh.enabled, true, JSON.stringify(fresh));
});

test('③-3 옛 앱의 고르기는 서버가 거절하고 브리지 값을 쓰지 않는다', () => {
  const out = run({ crews: personal(3, 'paused'), pauseReason: 'app', minApp: 'old', body: { keep: ['ws1:a'], personal: true }, enabled: true });
  assert.notEqual(out.status, 200);
  assert.equal(out.enabled, true);
  assert.ok(!out.log.some((l) => l.startsWith('enabled=')), String(out.log));
});

test('④ 조직 등록을 모두 해제했고 연결된 개인 행이 없으면(없음·available·detached) 끈다(종전 그대로)', () => {
  const none = orgDel([]);
  assert.equal(none.status, 200);
  assert.deepEqual(none.rows, []);
  assert.equal(none.enabled, false);
  const off = orgDel([{ slug: 'a', status: 'available', org_id: null }, { slug: 'b', status: 'detached', org_id: null }]);
  assert.equal(off.enabled, false, JSON.stringify(off));
});

test('⑤ 조직 등록을 해제해도 연결된 개인 행이 있으면 켜 둔다 — 개인 공간 에이전트도 브리지가 답한다', () => {
  const out = orgDel(personal(1));
  assert.deepEqual(out.rows, ['a:active']);
  assert.equal(out.enabled, true, JSON.stringify(out));
  assert.deepEqual(out.body.crews, [], '돌려주는 crews는 조직 등록만');
});

test('⑥ 조직 등록 연결은 브리지를 켠다(종전 그대로)', () => {
  const out = run({ crews: [], agents: ['a'], enabled: false, body: { orgId: ORG, slug: 'a' } });
  assert.equal(out.status, 200);
  assert.equal(out.enabled, true, JSON.stringify(out));
});

test('⑦ 개인 공간 [연결]은 종전처럼 브리지 값을 쓰지 않는다 — 새 앱 심박이 먼저 재개시킨다', () => {
  const out = run({ crews: personal(5, 'paused'), pauseReason: 'off', body: { activate: true, personal: true, slugs: ['a', 'b', 'c', 'd'] } });
  assert.equal(out.status, 200);
  assert.equal(out.enabled, true);
  assert.ok(!out.log.some((l) => l.startsWith('enabled=')), `브리지 값을 쓰지 않는다: ${out.log}`);
  assert.deepEqual(out.rows, ['a:active', 'b:active', 'c:active', 'd:active', 'e:paused']);
});

test('⑧ [다시 연결] — 조직 없는 계정의 꺼진 브리지를 연결된 개인 행으로 되살린다, 연결된 행이 없으면 종전처럼 noCrews', () => {
  const out = run({ crews: personal(4), enabled: false, body: { reconnect: true } });
  assert.equal(out.body.runtime.state, 'reconnecting', JSON.stringify(out));
  assert.equal(out.enabled, true);
  const none = run({ crews: [{ slug: 'a', status: 'available', org_id: null }], enabled: false, body: { reconnect: true } });
  assert.equal(none.body.runtime.state, 'noCrews');
  assert.equal(none.enabled, false);
});

test('⑧-a [다시 연결] — 멈춘 행만 있고 옛 앱이면 브리지를 꺼 두고 "다시 연결하는 중"이 아니라 업데이트 안내로 답한다', () => {
  const out = run({ crews: personal(2, 'paused'), pauseReason: 'app', minApp: 'old', enabled: true, body: { reconnect: true } });
  assert.equal(out.status, 403, JSON.stringify(out));
  assert.equal(out.body.errorCode, 'msgr_app_update_required');
  assert.equal(out.enabled, false);
});

test('⑧-b [다시 연결] — 멈춘 행만 있어도 새 앱이면 꺼진 브리지를 되살린다(심박이 나가야 서버가 재개한다)', () => {
  const out = run({ crews: personal(2, 'paused'), pauseReason: 'off', enabled: false, body: { reconnect: true } });
  assert.equal(out.body.runtime.state, 'reconnecting', JSON.stringify(out));
  assert.equal(out.enabled, true);
});

test('⑧-c [다시 연결] — 이 회사 소유자가 아닌 계정은 owner로 답하고 브리지 값을 쓰지 않는다', () => {
  const out = run({ ownerId: '33333333-3333-3333-3333-333333333333', crews: personal(2), enabled: false, body: { reconnect: true } });
  assert.equal(out.body.runtime.state, 'owner');
  assert.equal(out.enabled, false);
  assert.ok(!out.log.some((l) => l.startsWith('enabled=')), String(out.log));
});

test('⑨ 멈춘 행만인데 최소 버전 조회가 실패하면 옛 앱으로 판정하지 않는다 — 브리지 값 그대로, 쓰기 0', () => {
  const re = run({ crews: personal(2, 'paused'), pauseReason: 'off', pauseRpcFail: true, enabled: true, body: { reconnect: true } });
  assert.equal(re.body.runtime?.state, 'reconnecting', JSON.stringify(re));
  assert.equal(re.enabled, true);
  assert.ok(!re.log.some((l) => l.startsWith('enabled=')), String(re.log));
  const del = orgDel(personal(2, 'paused'), { pauseReason: 'off', pauseRpcFail: true, enabled: true });
  assert.equal(del.status, 200);
  assert.equal(del.enabled, true, JSON.stringify(del));
  assert.ok(!del.log.some((l) => l.startsWith('enabled=')), String(del.log));
});
