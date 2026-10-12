// 다시 로그인하면 데크의 "로그인 만료" 배너가 바로 걷힌다(#980 LOW-2, 2026-10-13).
// 배너는 턴 기록(authLost)만 봐서, 다시 로그인해도 다음 성공 턴까지 "만료"가 남아 사용자가 "안 고쳐졌다"고 오해했다.
// 잠그는 계약:
//  ① 자격 저장 단일 관문(saveRunnerCred)이 저장 시각(savedAt)을 남기고, /keys(runnerStatus)는 시각만 싣는다(자격 내용은 싣지 않는다).
//  ② 배너 판정(runnersAuthLost)은 다시 로그인한 시각보다 오래된 만료 기록을 무시하고, 그 뒤 새로 만료되면 다시 띄운다.
//  ③ 어느 시각을 믿을지(runnerAuthRenewedAt): 회사 자격으로 도는 러너는 회사 저장 시각만, host 마커·회사 자격 없음은 이 컴퓨터 로그인 파일 시각도.
//  ④ 터미널에서 다시 로그인(파일 보관 자격)한 시각을 detectRunners가 authAt으로 남긴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-relogin-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-relogin-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete process.env[key];

const { createCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { runnerStatus, detectRunners } = await import('../src/runners.mjs');
const { appendEvent, readEvents } = await import('../src/events.mjs');
const { runnersAuthLost, runnerAuthRenewedAt } = await import('../app/runner-usable.mjs');

const CLAUDE_KEY = `sk-ant-api03-${'x'.repeat(80)}`;
const tick = () => new Promise((r) => setTimeout(r, 15)); // 기록 시각이 같은 ms에 겹치지 않게
const lostTurn = (runner) => ({ type: 'turn', runner, ok: false, error: 'Failed to authenticate', selfHealed: true, authLost: true });
/** 데크 배너(app/c/[ws]/page.jsx AiKeyBanner)와 같은 계산 — /keys와 /activity가 주는 것으로 만료 러너를 고른다. */
const bannerLost = async (ws) => {
  const k = { runners: await runnerStatus(ws) };
  const renewed = Object.fromEntries(Object.entries(k.runners).map(([id, r]) => [id, runnerAuthRenewedAt(r)]));
  return runnersAuthLost(await readEvents(ws, 150), renewed).filter((id) => k.runners[id]?.company?.connected || k.runners[id]?.hostAuthed);
};

test('① 저장 관문이 시각을 남기고 /keys는 시각만 싣는다 — 다시 저장하면 시각이 바뀐다', async () => {
  const ws = 'relogin-save';
  await createCompany(ws, '다시 로그인', 'owner', null, 'ko');
  const before = Date.now();
  await saveRunnerCred(ws, 'claude', 'apikey', CLAUDE_KEY);
  const s1 = (await runnerStatus(ws)).claude.company;
  assert.equal(s1.connected, true);
  assert.match(s1.savedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'ISO 시각');
  assert.ok(Date.parse(s1.savedAt) >= before, '저장한 뒤의 시각');
  assert.doesNotMatch(JSON.stringify(s1), /x{20}/, '자격 내용은 싣지 않는다(마스킹 그대로)');
  await tick();
  await saveRunnerCred(ws, 'claude', 'apikey', CLAUDE_KEY);
  const s2 = (await runnerStatus(ws)).claude.company;
  assert.ok(Date.parse(s2.savedAt) > Date.parse(s1.savedAt), '다시 저장(다시 로그인)하면 시각이 새로 바뀐다');
});

test('② 실제 경로 — 만료 → 다시 로그인 → 배너 걷힘 → 또 만료 → 배너 다시 뜸', async () => {
  const ws = 'relogin-flow';
  await createCompany(ws, '다시 로그인 흐름', 'owner', null, 'ko');
  await saveRunnerCred(ws, 'claude', 'apikey', CLAUDE_KEY);
  await tick();
  await appendEvent(ws, lostTurn('claude'));
  assert.deepEqual(await bannerLost(ws), ['claude'], '만료 기록 → 배너');
  await tick();
  await saveRunnerCred(ws, 'claude', 'apikey', CLAUDE_KEY); // 설정에서 다시 연결
  assert.deepEqual(await bannerLost(ws), [], '다시 로그인하면 다음 성공 턴을 기다리지 않고 걷힌다');
  await tick();
  await appendEvent(ws, lostTurn('claude'));
  assert.deepEqual(await bannerLost(ws), ['claude'], '다시 로그인한 뒤 또 만료되면 다시 뜬다');
});

test('② 판정 칸 — 시각 비교·옛 자격·다른 러너·같은 시각', () => {
  const at = (iso) => Date.parse(iso);
  const ev = (runner, ts, o = {}) => ({ type: 'turn', runner, ok: false, authLost: true, ts, ...o });
  const old = ev('claude', '2026-10-13T01:00:00.000Z');
  assert.deepEqual(runnersAuthLost([old], { claude: at('2026-10-13T02:00:00.000Z') }), [], '다시 로그인보다 앞선 만료는 무시');
  assert.deepEqual(runnersAuthLost([ev('claude', '2026-10-13T03:00:00.000Z'), old], { claude: at('2026-10-13T02:00:00.000Z') }), ['claude'], '다시 로그인 뒤 새 만료는 띄운다');
  assert.deepEqual(runnersAuthLost([old]), ['claude'], '시각을 모르면(이 필드 도입 전 자격) 종전대로');
  assert.deepEqual(runnersAuthLost([old], { claude: 0 }), ['claude']);
  assert.deepEqual(runnersAuthLost([old], { codex: at('2026-10-13T02:00:00.000Z') }), ['claude'], '다른 러너의 다시 로그인은 이 러너와 무관');
  assert.deepEqual(runnersAuthLost([{ type: 'turn', runner: 'claude', ok: false, authLost: true }], { claude: at('2026-10-13T02:00:00.000Z') }), ['claude'], '시각 없는 기록은 종전대로(만료로 본다)');
  assert.deepEqual(runnersAuthLost([old], { claude: at(old.ts) }), ['claude'], '같은 시각은 무시하지 않는다(안전한 쪽 — 보인다)');
  // 자가치유 뒤 바깥 턴(authFailedRunner)도 같은 기준
  assert.deepEqual(runnersAuthLost([ev('codex', '2026-10-13T01:00:00.000Z', { authLost: false, authFailedRunner: 'claude' })], { claude: at('2026-10-13T02:00:00.000Z') }), []);
});

test('③ 어느 시각을 믿나 — 회사 자격은 회사 저장 시각만, host·회사 자격 없음은 이 컴퓨터 로그인 시각도', () => {
  const T1 = '2026-10-13T01:00:00.000Z', T2 = '2026-10-13T02:00:00.000Z';
  assert.equal(runnerAuthRenewedAt({ company: { connected: true, type: 'oauth', savedAt: T1 }, hostAuthAt: T2 }), Date.parse(T1), '회사 oauth는 이 컴퓨터 로그인으로 낫지 않는다');
  assert.equal(runnerAuthRenewedAt({ company: { connected: true, type: 'apikey' } }), 0, '옛 자격(시각 없음)');
  assert.equal(runnerAuthRenewedAt({ company: { connected: true, type: 'host', savedAt: T1 }, hostAuthAt: T2 }), Date.parse(T2), 'host 마커 — 터미널에서 다시 로그인');
  assert.equal(runnerAuthRenewedAt({ company: { connected: true, type: 'host', savedAt: T2 }, hostAuthAt: T1 }), Date.parse(T2), 'host 마커 — 설정에서 다시 옵트인');
  assert.equal(runnerAuthRenewedAt({ company: { connected: false }, hostAuthAt: T1 }), Date.parse(T1), '회사 자격 없음(이 컴퓨터 로그인으로 돈다)');
  assert.equal(runnerAuthRenewedAt({ company: { connected: false } }), 0);
  assert.equal(runnerAuthRenewedAt(undefined), 0);
});

test('④ 터미널에서 다시 로그인한 시각 — 파일 보관 자격의 수정 시각을 authAt으로, 없으면 없다', async () => {
  const home = process.env.HOME;
  assert.equal((await detectRunners(true)).claude.authAt, undefined, '로그인 파일이 없으면 시각도 없다');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), '{}');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'auth.json'), '{}');
  const when = new Date('2026-10-13T02:00:00.000Z');
  await utimes(join(home, '.claude', '.credentials.json'), when, when);
  await utimes(join(home, '.codex', 'auth.json'), when, when);
  const d = await detectRunners(true);
  assert.equal(d.claude.authAt, when.toISOString());
  assert.equal(d.claude.authed, true, '존재 판정은 그대로');
  assert.equal(d.codex.authAt, when.toISOString());
  assert.equal(typeof d.codex.authed, 'boolean', 'authed는 참·거짓 그대로(시각 문자열이 새지 않는다)');
  await mkdir(join(home, '.gemini'), { recursive: true });
  assert.equal(d.gemini.authAt, undefined);
  const st = await runnerStatus('relogin-save');
  assert.equal(st.claude.hostAuthAt, when.toISOString(), '/keys에도 시각만 실린다');
});
