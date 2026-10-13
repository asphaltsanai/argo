// 리스·텔레그램 클레임의 요청 간격(2026-10-13 로그 수집 과금 — 리스 한 번 = edge 로그 + storage 로그 1~3줄).
// 쉬는 동안(바뀐 것 없음) 보유자가 몇 번 읽고 쓰는지를 가짜 시계로 센다. 가짜 저장소로 renewLease 결선을 직접 구동한다(lease-standby.test.mjs와 같은 방식).
// 가짜 시계는 Date만 바꾼다 — 판정 하나를 끝까지 기다린 뒤 시계를 넘긴다(#873 교훈: 넘기기 전에 흐름을 비운다).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-cadence-'));
process.env.ARGO_SYNC = '1';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-cadence', email: '' } }), { mode: 0o600 });
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const sync = await import('../src/sync.mjs');
const { renewLease, isCloudLeader, _setSyncClientForTest, LEASE_TTL_MS, LEASE_RENEW_MS } = sync;
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();
const ACCT = 'u-cadence';

/** 가짜 저장소 — 객체별로 담고, 읽기·쓰기를 키별로 센다. failReads(...errs) = 다음 읽기들이 차례로 돌려줄 오류. */
const fakeStore = () => {
  const objs = new Map();
  const calls = { upload: 0, download: 0, byKey: new Map() };
  const failNext = [];
  const count = (op, key) => { const k = `${op} ${String(key).split('?')[0]}`; calls.byKey.set(k, (calls.byKey.get(k) || 0) + 1); };
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key) {
      calls.download += 1; count('GET', key);
      const f = failNext.shift();
      if (f?.throw) throw f.throw;
      if (f) return { data: null, error: f };
      const b = objs.get(String(key).split('?')[0]);
      return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } };
    },
    async upload(key, blob) { calls.upload += 1; count('PUT', key); objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
    async remove(keys) { for (const k of keys) { count('DEL', k); objs.delete(k); } return { data: [], error: null }; },
  };
  return {
    client: { storage: { from: () => bucket } }, calls,
    get: (key) => { const b = objs.get(key); return b ? JSON.parse(b.toString()) : null; },
    set: (key, doc) => { objs.set(key, Buffer.from(JSON.stringify(doc))); },
    failReads: (...errs) => { failNext.push(...errs); },
  };
};
const LEASE_KEY = (owner) => `${owner}/_device-lease.json`;
const lease = () => globalThis.__argoSyncLease;
/** 깨어 있음 관찰을 지금 시각으로 맞춘다 — 가짜 시계가 벽시계만 넘기므로, 그대로 두면 판정마다 '잠들었다 깸'으로 읽힌다. */
const awakeNow = (sinceAgo = 10 * 60_000) => {
  const a = (globalThis.__argoSyncAwake ??= {});
  if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer);
  Object.assign(a, { timer: 'test', wall: Date.now(), mono: performance.now(), wokeAt: a.wokeAt ?? 0 });
  if (sinceAgo != null) a.since = Date.now() - sinceAgo;
};
/** 확인된 보유자 — 방금 내 글(token)을 썼고 확인했다. sawPeer = 이 계정이 다른 기기를 본 적 있음(엄격 판정). */
const holder = (f, owner, { sawPeer = false } = {}) => {
  const token = `t-${owner}`;
  f.set(LEASE_KEY(owner), { deviceId: ME, token, ts: Date.now(), assistant: 2 });
  awakeNow(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  Object.assign(lease() ?? (globalThis.__argoSyncLease = {}), { leader: true, ownedAt: Date.now(), checkedAt: Date.now(), yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false,
    token, validUntil: Date.now() + 10_000, peers: sawPeer ? { [ACCT]: { at: Date.now(), normals: [] } } : {}, peersSavedAt: sawPeer ? { [ACCT]: Date.now() } : {} });
};
afterEach(() => mock.timers.reset());

/** 판정을 간격(stepMs)마다 durMs 동안 돌린다(가짜 시계). 매 판정 뒤 담당 여부를 모은다. */
async function idle(owner, { stepMs, durMs }) {
  const leaderEach = [];
  for (let t = 0; t < durMs; t += stepMs) {
    mock.timers.tick(stepMs); awakeNow(null);
    await renewLease(owner, { runnerUsable: true });
    leaderEach.push(isCloudLeader());
  }
  return leaderEach;
}

/* ── L2: 보유자의 다시 쓰기 60초, 갱신 때 확인 읽기 없음 ── */

for (const sawPeer of [false, true]) {
  test(`쉬는 보유자(${sawPeer ? '엄격 판정 — 다른 기기를 본 적 있음' : '단일 기기'}) — 10분 동안 리스 쓰기는 60초에 한 번, 갱신 때 확인 읽기 없음, 담당은 끊기지 않는다`, async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `owner-idle-${sawPeer ? 'strict' : 'solo'}`;
    holder(f, owner, { sawPeer });
    const each = await idle(owner, { stepMs: 8_000, durMs: 10 * 60_000 });
    const ticks = each.length;
    const puts = f.calls.byKey.get(`PUT ${LEASE_KEY(owner)}`) || 0;
    const gets = f.calls.byKey.get(`GET ${LEASE_KEY(owner)}`) || 0;
    assert.ok(puts >= 8 && puts <= 10, `10분 쓰기 ${puts}번 — 60초에 한 번(예전 30초면 약 19번)`);
    assert.equal(gets, ticks, `읽기 ${gets}번 = 판정 ${ticks}번 — 갱신 뒤 확인 읽기를 하지 않는다`);
    assert.deepEqual(each.filter((x) => !x), [], '담당이 한 번도 끊기지 않는다(엄격 판정의 확인 기한은 읽기가 늘린다)');
    assert.equal(f.get(LEASE_KEY(owner)).token, lease().token, '마지막 글의 토큰 = 메모리 토큰 — 다음 읽기가 확인으로 이어진다');
    assert.ok(Date.now() - f.get(LEASE_KEY(owner)).ts < LEASE_RENEW_MS + 8_000, '글은 60초 + 한 주기보다 오래되지 않는다(TTL 120초 안)');
  });
}

test('갱신 차례에 원격 글이 내 기기 id지만 다른 토큰이면(같은 기기의 다른 프로세스) 확인 읽기를 거친다 — 갱신 지름길은 내 토큰 그대로일 때만', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-other-proc';
  holder(f, owner);
  f.set(LEASE_KEY(owner), { deviceId: ME, token: 't-other-process', ts: Date.now(), assistant: 2 });
  lease().ownedAt = Date.now() - (LEASE_RENEW_MS + 1_000);
  await renewLease(owner, { runnerUsable: true });
  assert.equal(f.calls.byKey.get(`PUT ${LEASE_KEY(owner)}`), 1);
  assert.equal(f.calls.byKey.get(`GET ${LEASE_KEY(owner)}`), 2, '읽기 + 쓰기 뒤 확인 읽기');
  assert.equal(lease().leader, true, '확인 읽기에서 내 토큰이 이겼다');
  assert.equal(lease().token, f.get(LEASE_KEY(owner)).token);
});

test('리스 만료 경계 — 쉬는 보유자의 글은 다른 기기가 보기에 늘 살아 있다(글 나이 < TTL)', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-edge';
  holder(f, owner);
  let oldest = 0;
  for (let t = 0; t < 5 * 60_000; t += 8_000) {
    mock.timers.tick(8_000); awakeNow(null);
    oldest = Math.max(oldest, Date.now() - f.get(LEASE_KEY(owner)).ts);
    await renewLease(owner, { runnerUsable: true });
  }
  assert.ok(oldest < LEASE_TTL_MS - 40_000, `다른 기기가 본 가장 오래된 글 ${oldest / 1000}초 — TTL ${LEASE_TTL_MS / 1000}초까지 여유`);
});

/* ── T1: 텔레그램 클레임 — 보유자는 60초마다만 다시 쓴다(판정·읽기는 30초) ── */

const { setClaimTokens, renewTokenClaims, tokenOwnership, tokenClaimHash, _resetTokenClaimsForTest, CLAIM_REWRITE_MS, TG_CLAIM_TTL_MS } = sync;
const CLAIM_KEY = (owner, tok) => `${owner}/.tg-claims/${tokenClaimHash(tok)}.json`;

test('쉬는 클레임 보유자(토큰 5개) — 10분 동안 토큰마다 읽기는 30초, 쓰기는 60초에 한 번, 소유는 끊기지 않는다', async () => {
  _resetTokenClaimsForTest();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-claims'; const toks = ['c1', 'c2', 'c3', 'c4', 'c5'];
  setClaimTokens(toks);
  let now = Date.now();
  await renewTokenClaims(owner, { now }); // 획득(쓰기 + 확인 읽기)
  for (const t of toks) assert.equal(tokenOwnership(t).mine, true);
  const base = Object.fromEntries(toks.map((t) => [t, { put: f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, t)}`) || 0, get: f.calls.byKey.get(`GET ${CLAIM_KEY(owner, t)}`) || 0 }]));
  let ticks = 0; const lost = [];
  for (let el = 0; el < 10 * 60_000; el += 30_000) {
    now += 30_000; ticks += 1;
    await renewTokenClaims(owner, { now });
    for (const t of toks) if (!tokenOwnership(t).mine) lost.push(`${t}@${el}`);
  }
  for (const t of toks) {
    const puts = (f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, t)}`) || 0) - base[t].put;
    const gets = (f.calls.byKey.get(`GET ${CLAIM_KEY(owner, t)}`) || 0) - base[t].get;
    assert.ok(puts >= 9 && puts <= 10, `${t}: 10분 쓰기 ${puts}번 — 60초에 한 번(예전 30초면 20번)`);
    assert.equal(gets, ticks, `${t}: 읽기 = 판정 수(${ticks})`);
    assert.ok(now - f.get(CLAIM_KEY(owner, t)).ts < TG_CLAIM_TTL_MS - 30_000, `${t}: 다른 기기가 보기에 늘 살아 있는 클레임`);
  }
  assert.deepEqual(lost, [], '소유가 끊긴 판정 없음');
  assert.equal(CLAIM_REWRITE_MS, 60_000);
});
