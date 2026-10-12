// msgr-storage-sweep 순수 부분(엣지 index.ts와 test/msgr-storage-sweep.test.mjs가 같이 쓴다).
// 후보 이름은 DB 함수가 고른다 — msgr: msgr_storage_sweep_list(방이 없는 객체, 24시간 넘게 첨부 행이 없는 객체), msgr-avatars: msgr_storage_sweep_avatars
// (계정이 사라진 아바타, 20261012160000). 여기서는 받은 이름만 지운다.
export const BATCH = 200;
export const MAX_ROUNDS = 10;

/** list(n) → 후보 이름 배열, remove(names) → Storage API 삭제. 후보가 끝나거나, 지우기가 실패하거나, 지운 이름이 다시 오면 멈춘다. */
export async function runSweep({ list, remove, batch = BATCH, maxRounds = MAX_ROUNDS }) {
  const done = new Set();
  let removed = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const names = (await list(batch)) ?? [];
    if (!names.length) return { removed, rounds: round, stopped: 'empty' };
    if (names.every((n) => done.has(n))) return { removed, rounds: round, stopped: 'not_progressing' };
    const fresh = names.filter((n) => !done.has(n));
    try { await remove(fresh); } catch { return { removed, rounds: round, stopped: 'remove_failed' }; }
    for (const n of fresh) done.add(n);
    removed += fresh.length;
  }
  return { removed, rounds: maxRounds, stopped: 'max_rounds' };
}

/** 정리할 버킷과 후보 함수(20261012160000) — 메신저 첨부(방이 없는 객체·등록 실패), 계정이 사라진 공개 아바타 */
export const SWEEP_BUCKETS = [
  { bucket: 'msgr', rpc: 'msgr_storage_sweep_list' },
  { bucket: 'msgr-avatars', rpc: 'msgr_storage_sweep_avatars' },
];

/** 버킷 하나의 list·remove — DB 후보 함수(서비스 역할 RPC)와 Storage API 삭제. fetch를 받아 Node 시험이 가짜 서버로 같은 요청을 확인한다 */
export function bucketOps({ url, service, bucket, rpc, fetch: f = fetch }) {
  const H = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' };
  const list = async (n) => {
    const r = await f(`${url}/rest/v1/rpc/${rpc}`, { method: 'POST', headers: H, body: JSON.stringify({ p_limit: n }) });
    if (!r.ok) throw new Error(`list ${r.status}`);
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : []).map((x) => (typeof x === 'string' ? x : x?.[rpc])).filter(Boolean);
  };
  const remove = async (names) => {
    const r = await f(`${url}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: H, body: JSON.stringify({ prefixes: names }) });
    if (!r.ok) throw new Error(`remove ${r.status}`);
  };
  return { list, remove };
}

/** 버킷마다 runSweep — 한 버킷의 실패(후보 함수 없음·402·5xx)가 다른 버킷 정리를 막지 않는다. 실패한 버킷은 다음 크론에 다시(행이 남아 있으므로) */
export async function sweepBuckets({ url, service, buckets = SWEEP_BUCKETS, fetch: f = fetch, batch, maxRounds }) {
  const out = {};
  for (const b of buckets) {
    const { list, remove } = bucketOps({ url, service, bucket: b.bucket, rpc: b.rpc, fetch: f });
    try { out[b.bucket] = await runSweep({ list, remove, batch, maxRounds }); } catch (e) { out[b.bucket] = { removed: 0, stopped: 'list_failed', error: String(e?.message ?? e).slice(0, 120) }; }
  }
  return out;
}

const enc = new TextEncoder();
/** 길이와 무관한 비교(해시 후 XOR) — ls-reconcile과 같은 방식 */
export async function sameSecret(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
