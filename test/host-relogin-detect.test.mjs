// "이 컴퓨터 로그인 사용(host)"으로 연결한 러너는 터미널에서 다시 로그인하면 바로 회복돼야 한다(2026-10-15 작업 C, #984 LOW-2와 같은 원인).
// 종전: 감지(detectRunners) 10분 캐시가 "로그인 안 됨"을 쥐고 있어, 다시 로그인해도 최대 10분 동안 "재연결 필요(invalid)"로 남고 러너 선택(resolveRunner)이 그 러너를 건너뛰었다.
// 잠그는 계약:
//  ① host 마커인데 로그인 안 됨으로 판정된 동안은 감지를 짧은 주기(HOST_RECHECK_MS)로 다시 본다 — 다시 로그인하면 그 주기 안에 회복(상태·러너 선택 둘 다).
//  ② 로그인이 살아 있는 동안은 종전 10분 캐시 그대로(턴마다 CLI를 띄우지 않는다).
//  ③ 인증 실패를 만난 턴은 감지 캐시를 버린다(invalidateDetectCache) — 다음 판정이 지금 상태를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-hostrelogin-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hostrelogin-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ARGO_STANDALONE']) delete process.env[key];

const { createCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { runnerStatus, resolveRunner, detectRunners, invalidateDetectCache, HOST_RECHECK_MS } = await import('../src/runners.mjs');

const credFile = join(process.env.HOME, '.claude', '.credentials.json');
const login = async () => { await mkdir(join(process.env.HOME, '.claude'), { recursive: true }); await writeFile(credFile, '{}'); };
const logout = () => rm(credFile, { force: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('① host 마커 — 로그아웃 상태로 캐시된 뒤 터미널에서 다시 로그인하면 짧은 주기 안에 회복(상태·러너 선택)', async () => {
  const ws = 'host-relogin';
  await createCompany(ws, '호스트 재로그인', 'owner', null, 'ko');
  await saveRunnerCred(ws, 'claude', 'host', 'host');
  await logout();
  await detectRunners(true); // 로그아웃 상태를 캐시에 넣는다
  assert.equal((await runnerStatus(ws)).claude.company.invalid, true, '전제: 로그인 없음 → 재연결 필요');
  await login(); // 사용자가 터미널에서 다시 로그인
  await wait(HOST_RECHECK_MS + 50);
  assert.equal((await runnerStatus(ws)).claude.company.invalid, undefined, '10분 캐시를 기다리지 않고 회복 — 재연결 필요가 걷힌다');
  await logout(); await detectRunners(true); await login(); await wait(HOST_RECHECK_MS + 50);
  const r = await resolveRunner(ws, 'claude', { forPick: true });
  assert.deepEqual([r.runner, r.available], ['claude', true], '러너 선택(턴 경로)도 같은 주기 안에 그 러너를 다시 쓴다');
});

test('② 로그인이 살아 있으면 종전 10분 캐시 그대로 — 판정마다 다시 감지하지 않는다', async () => {
  const ws = 'host-alive';
  await createCompany(ws, '호스트 정상', 'owner', null, 'ko');
  await saveRunnerCred(ws, 'claude', 'host', 'host');
  await login();
  const a = await detectRunners(true);
  await wait(HOST_RECHECK_MS + 50);
  await runnerStatus(ws);
  assert.equal(await detectRunners(), a, '같은 캐시 객체 — 다시 감지하지 않았다');
});

test('③ 인증 실패 계기 — invalidateDetectCache 뒤 다음 판정은 지금 상태를 본다', async () => {
  await login();
  const a = await detectRunners(true);
  invalidateDetectCache();
  const b = await detectRunners();
  assert.notEqual(b, a, '캐시를 버리고 새로 감지했다');
});

test('③ 실제 계기 — host 자격(또는 회사 자격 없음) 턴의 인증 실패는 감지 캐시를 버린다, 회사 자격 턴은 버리지 않는다', async () => {
  const { surfaceRunnerFailure } = await import('../src/chat.mjs');
  const authErr = () => Object.assign(new Error('Failed to authenticate. OAuth session expired'), { authError: true });
  await login();
  let a = await detectRunners(true);
  await surfaceRunnerFailure(authErr(), { wsId: 'host-relogin', runner: 'claude', lang: 'ko', cred: { type: 'host', value: 'host' } });
  assert.notEqual(await detectRunners(), a, 'host 자격 턴 — 캐시를 버렸다');
  a = await detectRunners(true);
  await surfaceRunnerFailure(authErr(), { wsId: 'host-relogin', runner: 'claude', lang: 'ko', loadCredFn: async () => null });
  assert.notEqual(await detectRunners(), a, '회사 자격 없음(이 컴퓨터 로그인 폴백) — 캐시를 버렸다');
  a = await detectRunners(true);
  await surfaceRunnerFailure(authErr(), { wsId: 'host-relogin', runner: 'claude', lang: 'ko', cred: { type: 'apikey', value: 'k' }, verifyFn: async () => ({ ok: null }), markFn: async () => {} });
  assert.equal(await detectRunners(), a, '회사 자격 턴은 감지와 무관 — 캐시를 그대로 둔다');
});
