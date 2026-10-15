// 같은 계정 codex 구독 회복(2026-10-15 유건 승인 예외 — creds.mjs credType 주석): 회사 codex 구독 로그인이 인증 실패로 막혔을 때, 이 컴퓨터의
// codex 로그인(~/.codex/auth.json)이 같은 ChatGPT 계정이고 살아 있는 더 새 로그인이면 반입(savedAt 갱신 → 배너 해제)하고 그 턴을 같은 러너로 1회 재시도한다.
// 잠그는 계약:
//  ① 반입 판정(reabsorbCodexFromHost): 같은 계정·살아 있음·더 새 것일 때만. 다른 계정·만료·같은 토큰·apikey·host·claude·파일 없음은 반입 안 함. 두 번째 호출은 반입 안 함(무한 반복 없음).
//  ② 턴 전 게이트(runnerCredEnv knownInvalid)보다 반입이 먼저 — 반입되면 판정이 지워져 실행, 없으면 종전대로 끊는다.
//  ③ 실제 턴(chat): codex 인증 실패 → 반입 → 같은 러너 1회 재시도로 성공. 다른 계정이면 반입 없이 종전 자가치유(다른 러너)로. 재시도도 실패하면 반입 1회로 끝.
//  ④ 자가치유 계약(AUTH_ERR_RE·shouldSelfHeal)은 그대로.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-reabsorb-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-reabsorb-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' }); // codex 구독 = 기본 CLI 턴 경로
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in reabsorb test'); };
const wrappers = new Map();
for (const [relative, replacements] of [
  // 러너 해석·CLI 실행만 대역 — 반입·게이트·자가치유 판정은 실제 함수
  ['./runners.mjs', `
    export const resolveRunner = async (_ws, _want, { exclude = [] } = {}) => {
      const chain = ['codex', 'gemini'];
      const next = chain.find((r) => !(exclude ?? []).includes(r));
      return next ? { runner: next, available: true, fellBack: next !== chain[0] } : { runner: chain[0], available: false };
    };
    export const isBilledRunner = async () => false;
    export const externalExec = (...args) => globalThis.__argoReabsorbExec(...args);
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
after(() => { hooks.deregister(); globalThis.fetch = realFetch; delete globalThis.__argoReabsorbExec; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred, loadRunnerCred, reabsorbCodexFromHost, runnerCredEnv } = await import('../src/runners/creds.mjs');
const { markRunnerAuthFail } = await import('../src/runner-health.mjs');
const { runnerStatus } = await import('../src/runners.mjs');
const { chat, shouldSelfHeal } = await import('../src/chat.mjs');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (acct, expSec) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSec, 'https://api.openai.com/auth': { chatgpt_account_id: acct } })}.sig`;
const authJson = (acct, { exp = 3600, rt = 'rt' } = {}) => JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: jwt(acct, exp), refresh_token: rt, account_id: acct, id_token: '' }, last_refresh: '2026-10-15T00:00:00Z' });
const hostFile = join(process.env.HOME, '.codex', 'auth.json');
const putHost = async (v) => { await mkdir(join(process.env.HOME, '.codex'), { recursive: true }); await writeFile(hostFile, v); };
const noHost = () => rm(hostFile, { force: true });
const GEMINI_KEY = `AIza${'x'.repeat(35)}`;

async function company(ws) {
  await createCompany(ws, '코덱스 회복', 'owner', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'c.md'), '---\nname: 씨\nrole: 검증\nrunner: codex\n---\n검증용.\n');
  await saveRunnerCred(ws, 'gemini', 'apikey', GEMINI_KEY);
}
const saveCodex = (ws, type, value) => saveRunnerCred(ws, 'codex', type, value);

test('① 반입 판정 — 같은 계정·살아 있음·더 새 것일 때만, 두 번째는 반입 안 함', async () => {
  const ws = 'rb-judge';
  await createCompany(ws, '판정', 'owner', null, 'ko');
  await saveCodex(ws, 'oauth', authJson('acct_A', { exp: -60, rt: 'rt-old' }));
  const before = (await runnerStatus(ws, { forPick: true })).codex.company.savedAt;
  await noHost();
  assert.equal(await reabsorbCodexFromHost(ws), false, '호스트 로그인 없음');
  await putHost(authJson('acct_B', { rt: 'rt-other' }));
  assert.equal(await reabsorbCodexFromHost(ws), false, '다른 계정 — 반입하지 않는다');
  await putHost(authJson('acct_A', { exp: -10, rt: 'rt-host-dead' }));
  assert.equal(await reabsorbCodexFromHost(ws), false, '호스트 로그인도 만료');
  await putHost(authJson('acct_A', { rt: 'rt-new' }));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(await reabsorbCodexFromHost(ws), true, '같은 계정의 살아 있는 더 새 로그인 — 반입');
  const c = await loadRunnerCred(ws, 'codex');
  assert.equal(c.type, 'oauth');
  assert.equal(JSON.parse(c.value).tokens.refresh_token, 'rt-new', '호스트 로그인이 회사 자격이 됐다');
  assert.ok(Date.parse((await runnerStatus(ws, { forPick: true })).codex.company.savedAt) > Date.parse(before), 'savedAt 갱신 — 데크 배너 해제(#984)');
  assert.equal(await reabsorbCodexFromHost(ws), false, '두 번째 호출 — 더 새 것이 없다(무한 반복 없음)');
});

test('① 반입 판정 — codex 구독이 아니면 반입하지 않는다(apikey·host·없음)', async () => {
  await putHost(authJson('acct_A', { rt: 'rt-new2' }));
  for (const [ws, type, value] of [['rb-apikey', 'apikey', `sk-proj-${'y'.repeat(40)}`], ['rb-host', 'host', 'host'], ['rb-none', null, null]]) {
    await createCompany(ws, ws, 'owner', null, 'ko');
    if (type) await saveCodex(ws, type, value);
    assert.equal(await reabsorbCodexFromHost(ws), false, `${type ?? '자격 없음'} — 연결 방식·과금이 바뀌는 반입 금지`);
    if (type) assert.equal((await loadRunnerCred(ws, 'codex')).type, type, '자격 그대로');
  }
});

test('② 턴 전 게이트보다 반입이 먼저 — 반입되면 실행, 반입할 것이 없으면 종전대로 끊는다', async () => {
  const ws = 'rb-gate';
  await createCompany(ws, '게이트', 'owner', null, 'ko');
  const dead = authJson('acct_A', { exp: -60, rt: 'rt-dead' });
  await saveCodex(ws, 'oauth', dead);
  await markRunnerAuthFail(ws, 'codex', dead); // 직전 턴이 인증 실패로 각인
  await noHost();
  await assert.rejects(runnerCredEnv(ws, 'codex'), (e) => e.knownInvalid === true, '반입할 것이 없으면 종전대로 실행 전에 끊는다');
  await putHost(authJson('acct_A', { rt: 'rt-live' }));
  const env = await runnerCredEnv(ws, 'codex');
  assert.ok(env?.home, '반입 뒤 게이트 통과 — 격리 홈으로 실행 준비');
  const seeded = JSON.parse(await readFile(join(env.home, 'auth.json'), 'utf8'));
  assert.equal(seeded.tokens.refresh_token, 'rt-live', '격리 홈에 반입한 로그인이 깔렸다');
});

test('③ 실제 턴 — codex 인증 실패 → 같은 계정 로그인 반입 → 같은 러너로 1회 재시도해 성공', async () => {
  const ws = 'rb-turn';
  await company(ws);
  await saveCodex(ws, 'oauth', authJson('acct_A', { exp: -60, rt: 'rt-dead2' }));
  await putHost(authJson('acct_A', { rt: 'rt-live2' }));
  const calls = [];
  globalThis.__argoReabsorbExec = async ({ runner }) => {
    calls.push(runner);
    if (calls.length === 1) throw new Error('Failed to authenticate: refresh token expired. Please run codex login');
    return '회복됨';
  };
  const out = await chat(ws, 'c', '안녕', null, {});
  assert.deepEqual(calls, ['codex', 'codex'], `같은 러너로 1회 재시도(다른 러너로 갈아타지 않았다): ${calls}`);
  assert.match(String(out?.text ?? out?.reply ?? JSON.stringify(out)), /회복됨/);
  assert.equal(JSON.parse((await loadRunnerCred(ws, 'codex')).value).tokens.refresh_token, 'rt-live2');
});

test('③ 실제 턴 — 다른 계정이면 반입 없이 종전 자가치유(다른 러너), 재시도도 실패하면 반입은 1회로 끝', async () => {
  const ws = 'rb-turn-other';
  await company(ws);
  await saveCodex(ws, 'oauth', authJson('acct_A', { exp: -60, rt: 'rt-dead3' }));
  await putHost(authJson('acct_B', { rt: 'rt-b' }));
  let calls = [];
  globalThis.__argoReabsorbExec = async ({ runner }) => { calls.push(runner); if (runner === 'codex') throw new Error('Failed to authenticate: refresh token expired'); return '대체 러너'; };
  await chat(ws, 'c', '안녕', null, {});
  assert.deepEqual(calls, ['codex', 'gemini'], `다른 계정 — 반입 없이 종전 자가치유: ${calls}`);
  assert.equal(JSON.parse((await loadRunnerCred(ws, 'codex')).value).tokens.refresh_token, 'rt-dead3', '회사 자격 그대로');

  await putHost(authJson('acct_A', { rt: 'rt-also-dead' })); // 같은 계정이지만 실제로는 거절되는 로그인
  calls = [];
  await chat(ws, 'c', '안녕', null, {});
  assert.deepEqual(calls, ['codex', 'codex', 'gemini'], `반입 1회 → 재시도 실패 → 더 반입하지 않고 종전 자가치유: ${calls}`);
});

test('④ 자가치유 판정 계약 그대로 — 인증 문구·authExpired만', () => {
  assert.equal(shouldSelfHeal(new Error('Failed to authenticate: OAuth session expired')), true);
  assert.equal(shouldSelfHeal(Object.assign(new Error('x'), { authExpired: 'codex' })), true);
  assert.equal(shouldSelfHeal(new Error('model not supported')), false);
});
