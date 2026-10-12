// 실행기의 AI 로그인이 만료됐을 때 메신저 사용자에게 원인과 고칠 곳을 알린다(2026-10-13 00:42 KST 맥 one 상주 사례: Claude OAuth 만료 → codex 재시도도 실패 →
// 메신저·오피스 답이 전부 "에이전트가 지금 답하지 못했습니다…" 일반 문구. 로그에만 "Failed to authenticate: OAuth session expired"가 있었다).
// 잠그는 계약:
//  ① chat()이 인증 때문에 다른 러너로 갈아탔다가 그 러너도 실패하면, 최종 오류에 처음 만료된 러너(authFailedRunner)가 남고 실패 기록에 authLost가 붙는다(실제 chat — 러너 해석·CLI 실행만 대역).
//  ② 메신저 방 글은 그 러너 이름과 할 일만 말한다 — 원문·토큰·계정은 싣지 않는다(D26). 인증이 아닌 실패는 종전 일반 문구.
//  ③ 자가치유 발동 판정(AUTH_ERR_RE·shouldSelfHeal)은 그대로 — 첫 실패에서 다른 러너로 실제로 넘어간다.
//  ④ 데크 배너 판정(runnersAuthLost): 러너별 최신 턴이 인증 때문에 실패했으면 만료, 더 최근 성공이 있으면 해제.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-auth-reason-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-auth-reason-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' }); // gemini·codex API 키 = CLI 턴
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in auth reason test'); };
const wrappers = new Map();
for (const [relative, replacements] of [
  // 러너 해석만 고정 — gemini가 먼저, gemini를 빼면 codex(자가치유 대체). 턴 전 자격 게이트·자가치유 판정은 실제 함수.
  ['./runners.mjs', `
    export const resolveRunner = async (_ws, _want, { exclude = [] } = {}) => (exclude ?? []).includes('gemini')
      ? ((exclude ?? []).includes('codex') ? { runner: 'gemini', available: false } : { runner: 'codex', available: true, fellBack: true })
      : { runner: 'gemini', available: true, fellBack: false };
    export const isBilledRunner = async () => false;
    export const externalExec = (...args) => globalThis.__argoAuthReasonExec(...args);
  `],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./runners/catalog-remote.mjs', 'export const loadRemoteCatalog = async () => null;'],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)};\n${replacements}`)}`);
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/\/src\/chat\.mjs$/.test(context.parentURL ?? '') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = realFetch; delete globalThis.__argoAuthReasonExec; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { readEvents } = await import('../src/events.mjs');
const { chat } = await import('../src/chat.mjs');
const { roomAuthRunner, roomTurnFailureFor, roomTurnFailure } = await import('../src/gateway/msgr-room-errors.mjs');
const { runnersAuthLost } = await import('../app/runner-usable.mjs');
const GEMINI_KEY = `AIza${'x'.repeat(35)}`;
const CODEX_KEY = `sk-proj-${'y'.repeat(40)}`;

async function company(ws) {
  await createCompany(ws, '인증 사유', 'owner', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'g.md'), '---\nname: 지\nrole: 검증\nrunner: gemini\n---\n검증용.\n');
  await saveRunnerCred(ws, 'gemini', 'apikey', GEMINI_KEY);
  await saveRunnerCred(ws, 'codex', 'apikey', CODEX_KEY);
}

test('① 인증 만료 → 다른 러너로 재시도 → 그 러너도 실패: 최종 오류에 처음 만료된 러너, 실패 기록에 authLost', async () => {
  const ws = 'auth-reason-chain';
  await company(ws);
  const calls = [];
  globalThis.__argoAuthReasonExec = async (runner) => {
    calls.push(runner);
    if (calls.length === 1) throw new Error('Failed to authenticate: OAuth session expired. Please run /login'); // 상주 실측 원문 모양(AUTH_ERR_RE)
    throw new Error("The 'gpt-x' model is not supported when using Codex with a ChatGPT account."); // 대체 러너의 다른 실패(워커 1이 고치는 계열)
  };
  let err = null;
  await chat(ws, 'g', '안녕', null, {}).catch((e) => { err = e; });
  assert.ok(err, '턴은 실패해야 한다');
  assert.equal(calls.length, 2, `③ 자가치유가 실제로 다른 러너로 넘어갔다(호출 ${calls.length}회)`);
  assert.equal(err.authFailedRunner, 'gemini', `처음 만료된 러너가 최종 오류에 남아야 한다(${JSON.stringify({ authFailedRunner: err.authFailedRunner, failRunner: err.failRunner, failCode: err.failCode })})`);
  const ev = (await readEvents(ws, 50)).find((e) => e.type === 'turn' && e.selfHealed);
  assert.ok(ev, '자가치유 직전 실패 기록');
  assert.equal(ev.runner, 'gemini');
  assert.equal(ev.authLost, true, '인증 때문에 갈아탄 기록 — 데크 배너가 읽는다');
  assert.deepEqual(runnersAuthLost(await readEvents(ws, 150)).includes('gemini'), true, '④ 데크 배너 판정이 그 러너를 만료로 본다');
  // ② 메신저 방 글 — 러너 이름과 할 일, 원문 없음
  const room = roomTurnFailureFor(err, 'ko');
  assert.match(room, /Gemini 로그인이 만료/);
  assert.match(room, /실행기 주인/);
  assert.doesNotMatch(room, /OAuth session|gpt-x|AIza|sk-proj|\/login/, `원문·자격이 방에 샜다: ${room}`);
  assert.match(roomTurnFailureFor(err, 'en'), /Gemini login on the runner behind this agent has expired/);
});

test('② 메신저 방 글 판정 — 필드만 본다(원문 재판정 없음), 인증이 아니면 일반 문구', () => {
  assert.equal(roomAuthRunner({ authExpired: 'claude', message: 'claude credential known-invalid since … — not started' }), 'claude', '턴 전 게이트가 끊은 러너');
  assert.equal(roomAuthRunner({ failCode: 'auth_expired', failRunner: 'grok', authError: true }), 'grok');
  assert.equal(roomAuthRunner({ authError: true }), 'unknown', '러너를 모르면 이름 없이');
  assert.equal(roomAuthRunner({ authFailedRunner: 'claude', failCode: 'model', failRunner: 'codex' }), 'claude', '첫 원인 우선');
  assert.equal(roomAuthRunner({ message: 'Failed to authenticate: OAuth session expired' }), null, '필드 없는 원문은 다시 판정하지 않는다(판정은 chat.mjs 한 곳)');
  assert.equal(roomAuthRunner({ subscriptionBlocked: true, authError: true }), null, '구독 차단은 인증 만료가 아니다');
  assert.equal(roomAuthRunner({ aborted: true, authFailedRunner: 'claude' }), null, '중단');
  assert.equal(roomAuthRunner({ failCode: 'credit' }), null);
  assert.equal(roomTurnFailureFor({ failCode: 'model' }, 'ko'), roomTurnFailure('ko'), '인증이 아닌 실패는 종전 일반 문구');
  assert.equal(roomTurnFailureFor(null, 'en'), roomTurnFailure('en'));
  assert.match(roomTurnFailureFor({ authError: true }, 'ko'), /AI 로그인이 만료/);
  const secretish = { authFailedRunner: 'claude', message: 'oauth token sk-ant-oat01-AAAA for me@example.com expired' };
  assert.doesNotMatch(roomTurnFailureFor(secretish, 'ko'), /sk-ant|@example\.com|token/, '토큰·계정이 방에 오르지 않는다');
});

test('④ 데크 배너 판정 — 러너별 최신 턴만, 더 최근 성공이면 해제, 중단·다른 실패는 제외', () => {
  const ev = (o) => ({ type: 'turn', ok: false, ...o });
  assert.deepEqual(runnersAuthLost([ev({ runner: 'claude', authLost: true, selfHealed: true }), ev({ runner: 'codex', failCode: 'model' })]), ['claude']);
  assert.deepEqual(runnersAuthLost([{ type: 'turn', runner: 'claude', ok: true }, ev({ runner: 'claude', authLost: true })]), [], '다시 로그인한 뒤 성공했으면 해제');
  assert.deepEqual(runnersAuthLost([ev({ runner: 'grok', failCode: 'auth_expired' })]), ['grok']);
  assert.deepEqual(runnersAuthLost([ev({ runner: 'claude', aborted: true, error: 'aborted' }), ev({ runner: 'claude', authLost: true })]), ['claude'], '중단 턴은 원인이 아니라 건너뛴다');
  assert.deepEqual(runnersAuthLost([{ type: 'runner-health', runner: 'claude', ok: false }]), [], '검진 실패는 이 판정 밖(카드가 따로 본다)');
  assert.deepEqual(runnersAuthLost(null), []);
});
