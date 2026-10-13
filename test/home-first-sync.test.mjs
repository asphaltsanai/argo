// 새 기기 첫 로그인 — 회사 동기화가 끝나도 홈이 빈 목록("회사 만들기")에 머물던 결함(2026-10-13 유건 실제 사례, 맥 two·설치본 0.1.105:
// lean-ax-wqou 3,725개 파일이 12:35~12:38에 다 내려왔는데 홈은 마운트 때 한 번 부른 빈 목록 그대로 — 같은 회사를 새로 만들 위험).
// 잠그는 계약(firstSyncPending — /api/companies의 syncing, 홈은 이 값이 참이고 목록이 비어 있으면 "내려받는 중" + 목록 다시 부르기):
//  A. 새 기기(로컬 회사 0개)에 원격 회사가 있으면, 그 회사가 로컬에 다 내려오기 전에는 내내 참이고 다 내려오면 거짓이 된다(거짓인데 회사가 없는 틈 없음).
//  B. 첫 동기화가 끝난 뒤 원격에서 새로 발견한 회사를 내려받는 동안에도 참이다(restoring 표지).
//  C. 기기 전체 오류(자격 거절 등)면 거짓 — 끝나지 않는 "내려받는 중"과 끝없는 다시 부르기를 막는다.
//  D. 동기화가 꺼져 있으면(기기 세션 없음·ARGO_SYNC=0) 거짓.
// 실제 동기화 루프(ensureSync)를 자식 프로세스로 돌리고 가짜 Supabase HTTP(실제 supabase-js)를 쓴다 — sync-empty-remote-restore와 같은 틀.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl } from './helpers/sync-child.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-firstsync-parent-')); // 봉인(secretbox → workspace.mjs) 임포트보다 먼저 — 이 프로세스도 실제 데이터 루트를 보지 않게
const OWNER = 'u1';
const key = (ws, rel) => `companies/${OWNER}/${ws}/${rel}`;
const meta = (buf) => ({ m: 1000, s: buf.length, h: createHash('sha1').update(buf).digest('hex').slice(0, 16) });

/** 로컬 회사 없이 기기 세션만 — 새 기기에 막 로그인한 상태(seedRoot는 로컬 회사를 하나 깔아 쓰지 않는다). */
async function newDeviceRoot(url, { expiresAt = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'argo-firstsync-'));
  writeFileSync(join(root, '.device-session.json'), JSON.stringify({
    url, anonKey: 'anon-fixture', access_token: 'h.p.s', refresh_token: 'rt-0', expires_at: expiresAt, user: { id: OWNER, email: '' },
  }), { mode: 0o600 });
  writeFileSync(join(root, '.device-id'), 'fixture-mac-0001');
  return root;
}

/** 원격에 회사 하나(봉인된 매니페스트 + company.json + 노트 n개)를 둔다. */
async function putRemoteCompany(fake, ws, n = 3) {
  const { sealSecret } = await import('../src/secretbox.mjs');
  const files = {};
  const co = Buffer.from(JSON.stringify({ id: ws, name: '원격 회사', ownerId: OWNER }));
  fake.store.set(key(ws, 'company.json'), co); files['company.json'] = meta(co);
  for (let i = 0; i < n; i++) { const b = Buffer.from(`# 노트 ${i}\n`); fake.store.set(key(ws, `vault/n${i}.md`), b); files[`vault/n${i}.md`] = meta(b); }
  fake.store.set(key(ws, '__manifest__.json'), sealSecret(Buffer.from(JSON.stringify({ files }))));
}

/** 자식에서 동기화를 켜고 50ms마다 { 첫 동기화 중?, 회사 폴더가 있나, 사이클이 끝났나 }를 기록한다. 첫 사이클이 끝나면 '##cycle'을 한 번 알린다. */
function runChild(root, ws, { ms, env = {}, onCycle } = {}) {
  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const { existsSync } = await import('node:fs');
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const samples = []; let told = false;
const sample = () => { const s = sync.syncStatus(); samples.push({ p: sync.firstSyncPending(), has: existsSync(${JSON.stringify(join(root, ws, 'company.json'))}), done: s.lastTs !== null, err: !!s.lastError });
  if (s.lastTs !== null && !told) { told = true; process.stdout.write('\\n##cycle\\n'); } };
sample();
sync.ensureSync();
const t0 = Date.now();
while (Date.now() - t0 < ${Number(ms)}) { await new Promise((r) => setTimeout(r, 50)); sample(); }
process.stdout.write('\\n@@' + JSON.stringify(samples) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, { ARGO_SYNC_CYCLE_MS: '200', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', cycled = false;
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; if (!cycled && out.includes('##cycle')) { cycled = true; onCycle?.(); } });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${err.slice(-1500)}`)); }, ms + 30_000);
    p.on('exit', () => { clearTimeout(t); const line = out.split('\n').find((l) => l.startsWith('@@')); line ? resolve(JSON.parse(line.slice(2))) : reject(new Error(`no samples\n${out.slice(-1500)}\n${err.slice(-1500)}`)); });
  });
}

test('A. 새 기기 — 원격 회사가 다 내려오기 전에는 내내 "내려받는 중", 다 내려오면 끝', { timeout: 90_000 }, async () => {
  const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
  await useFakeAccountKey(1, OWNER);
  const WS = 'co-remote';
  const fake = await startFakeSupabase({ userId: OWNER, syncIndex: { companies: [WS] } });
  try {
    await putRemoteCompany(fake, WS);
    fake.fault = (req, path) => (req.method === 'GET' && path.includes(`/${WS}/`) && !path.endsWith('__manifest__.json') ? 250 : null); // 파일 받기를 느리게 — 내려받는 구간을 관찰한다
    const s = await runChild(await newDeviceRoot(fake.url), WS, { ms: 8000 });
    assert.equal(s[0].p, true, '로그인 직후(동기화 시작 전) — 빈 목록이 "회사 없음"이 아니라 "내려받는 중"');
    assert.ok(s.every((x) => x.p || x.has), `회사가 아직 없는데 "내려받는 중"이 아닌 순간이 없다: ${JSON.stringify(s.filter((x) => !x.p && !x.has).slice(0, 3))}`);
    const last = s.at(-1);
    assert.deepEqual([last.p, last.has, last.done], [false, true, true], '다 내려오면 끝 — 홈이 다시 부른 목록에 회사가 있다');
  } finally { await fake.close(); }
});

test('B. 첫 동기화가 끝난 뒤 새로 발견한 회사를 내려받는 동안에도 "내려받는 중"(restoring 표지)', { timeout: 90_000 }, async () => {
  const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
  await useFakeAccountKey(1, OWNER);
  const WS = 'co-later';
  const index = { companies: [] };
  const fake = await startFakeSupabase({ userId: OWNER, syncIndex: index });
  try {
    await putRemoteCompany(fake, WS);
    fake.fault = (req, path) => (req.method === 'GET' && path.includes(`/${WS}/`) && !path.endsWith('__manifest__.json') ? 400 : null);
    const s = await runChild(await newDeviceRoot(fake.url), WS, { ms: 9000, env: { ARGO_SYNC_DISCOVER_MS: '1500' }, onCycle: () => { index.companies.push(WS); } });
    const firstDone = s.findIndex((x) => x.done);
    assert.ok(firstDone >= 0, '첫 사이클이 끝났다');
    assert.equal(s[firstDone].has, false, '전제: 첫 사이클 땐 원격에 회사가 없었다(빈 계정)');
    const after = s.slice(firstDone);
    assert.ok(after.some((x) => !x.p && !x.has), '전제: 빈 계정으로 첫 동기화가 끝나면 "내려받는 중"이 아니다(보통 온보딩)');
    const restoring = after.filter((x) => x.p && !x.has);
    assert.ok(restoring.length > 0, '새로 발견한 회사를 내려받는 동안 "내려받는 중"이 다시 참이다(restoring)');
    assert.deepEqual([s.at(-1).p, s.at(-1).has], [false, true], '다 내려오면 끝');
  } finally { await fake.close(); }
});

test('C. 자격이 거절되면(기기 전체 오류) "내려받는 중"이 끝난다 — 끝없는 다시 부르기 없음', { timeout: 60_000 }, async () => {
  const fake = await startFakeSupabase({ userId: OWNER, syncIndex: { companies: [] } });
  try {
    // 기기 세션이 만료됐고 토큰 갱신도 거절된다 — 동기화 사이클이 한 번도 끝나지 못하고(lastTs 없음) 기기 전체 오류만 남는 경로
    fake.fault = (req, path) => (path === '/auth/v1/token' ? { status: 400, body: { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } } : null);
    const s = await runChild(await newDeviceRoot(fake.url, { expiresAt: Math.floor(Date.now() / 1000) - 60 }), 'co-none', { ms: 4000 });
    const last = s.at(-1);
    assert.equal(last.err, true, `전제: 기기 전체 오류가 기록됐다: ${JSON.stringify(last)}`);
    assert.equal(last.done, false, '전제: 사이클이 한 번도 끝나지 않았다(lastTs 없음)');
    assert.equal(last.p, false, '오류면 "내려받는 중"이 아니다');
  } finally { await fake.close(); }
});

test('D. 동기화가 꺼져 있으면 "내려받는 중"이 아니다(기기 세션 없음·ARGO_SYNC=0)', { timeout: 60_000 }, async () => {
  const empty = await mkdtemp(join(tmpdir(), 'argo-firstsync-off-'));
  mkdirSync(join(empty, 'x'), { recursive: true });
  const off1 = await runChild(empty, 'co-none', { ms: 300 });
  assert.ok(off1.every((x) => x.p === false), '기기 세션 없음(로그인 전·게스트)');
  const fake = await startFakeSupabase({ userId: OWNER });
  try {
    const off2 = await runChild(await newDeviceRoot(fake.url), 'co-none', { ms: 300, env: { ARGO_SYNC: '0' } });
    assert.ok(off2.every((x) => x.p === false), 'ARGO_SYNC=0');
  } finally { await fake.close(); }
});
