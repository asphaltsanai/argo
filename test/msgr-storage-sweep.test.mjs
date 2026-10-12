// 메신저 저장소 정리(supabase/functions/msgr-storage-sweep, 20261011150000 5절) — 방이 없는 객체·24시간 넘게 첨부 행이 없는 객체를
// Storage API로 지운다(SQL 행 삭제는 바이트를 남긴다). 후보는 DB 함수(msgr_storage_sweep_list)가 고르고, 엣지는 받은 이름만 지운다.
// 고정하는 것: 후보가 없으면 지우기 호출 0 / 한 번에 200개씩, 최대 10번 / 지우기가 실패하면 그 자리에서 멈춘다(같은 후보를 무한히 다시 보내지 않게) /
// 같은 이름을 두 번 지우지 않는다 / 비밀이 없거나 틀리면 아무것도 하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSweep, sameSecret } from '../supabase/functions/msgr-storage-sweep/core.js';

test('후보가 없으면 목록 1번만 읽고 지우기는 0번', async () => {
  const calls = [];
  const r = await runSweep({ list: async () => { calls.push('list'); return []; }, remove: async (n) => { calls.push(['remove', n]); } });
  assert.deepEqual(r, { removed: 0, rounds: 1, stopped: 'empty' });
  assert.deepEqual(calls, ['list']);
});

test('200개씩 지우고, 후보가 끝나면 멈춘다', async () => {
  let left = Array.from({ length: 450 }, (_, i) => `org/ch/${i}/f`);
  const removed = [];
  const r = await runSweep({ list: async (n) => left.slice(0, n), remove: async (names) => { removed.push(names.length); left = left.filter((x) => !names.includes(x)); } });
  assert.deepEqual(removed, [200, 200, 50]);
  assert.equal(r.removed, 450);
  assert.equal(r.stopped, 'empty');
});

test('한 번 실행은 최대 10번(2,000개)까지 — 남은 것은 다음 시간에', async () => {
  let i = 0;
  const r = await runSweep({ list: async (n) => Array.from({ length: n }, () => `x/${i++}`), remove: async () => {} });
  assert.equal(r.rounds, 10);
  assert.equal(r.removed, 2000);
  assert.equal(r.stopped, 'max_rounds');
});

test('지우기가 실패하거나 같은 이름이 다시 오면 멈춘다(무한 재시도 없음)', async () => {
  let n = 0;
  const fail = await runSweep({ list: async () => ['a', 'b'], remove: async () => { n++; throw new Error('storage 500'); } });
  assert.equal(n, 1);
  assert.equal(fail.stopped, 'remove_failed');
  const same = await runSweep({ list: async () => ['a', 'b'], remove: async () => {} });
  assert.equal(same.removed, 2);
  assert.equal(same.stopped, 'not_progressing', '지웠는데도 같은 후보가 오면(Storage가 지우지 못함) 두 번째 바퀴에서 멈춘다');
});

test('비밀 비교 — 같을 때만 참', async () => {
  assert.equal(await sameSecret('Bearer s3', 'Bearer s3'), true);
  assert.equal(await sameSecret('Bearer s3', 'Bearer s4'), false);
  assert.equal(await sameSecret('', 'Bearer s3'), false);
});

// 20261012160000 — 버킷별 정리(msgr 첨부·msgr-avatars 아바타). 가짜 Storage·REST 서버에 실제 fetch로 같은 요청을 보낸다.
import { createServer } from 'node:http';
import { sweepBuckets, SWEEP_BUCKETS } from '../supabase/functions/msgr-storage-sweep/core.js';

async function fakeSupabase({ lists, fail = {} }) {
  const reqs = [];
  const left = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, [...v]]));
  const srv = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization, apikey: req.headers.apikey, body: j });
      const rpc = req.url.match(/^\/rest\/v1\/rpc\/(\w+)$/)?.[1];
      if (rpc) {
        if (!(rpc in left)) { res.writeHead(404); return res.end('{"code":"PGRST202"}'); }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(left[rpc].slice(0, j.p_limit).map((n) => ({ [rpc]: n }))));
      }
      const bucket = req.url.match(/^\/storage\/v1\/object\/([\w-]+)$/)?.[1];
      if (req.method === 'DELETE' && bucket) {
        if (fail[bucket]) { res.writeHead(fail[bucket]); return res.end('{}'); }
        const rpcOf = SWEEP_BUCKETS.find((b) => b.bucket === bucket)?.rpc;
        left[rpcOf] = left[rpcOf].filter((n) => !j.prefixes.includes(n));
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]');
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, reqs, left, close: () => new Promise((r) => srv.close(r)) };
}

test('[버킷별] 첨부는 msgr 버킷, 아바타는 msgr-avatars 버킷으로 Storage API DELETE — 서비스 키, 후보가 비면 멈춘다', async () => {
  const s = await fakeSupabase({ lists: { msgr_storage_sweep_list: ['org/ch/1/a.pdf', 'p/ch/2/b.png'], msgr_storage_sweep_avatars: ['avatars/u1/me.jpg'] } });
  try {
    const out = await sweepBuckets({ url: s.url, service: 'svc' });
    assert.deepEqual(out.msgr, { removed: 2, rounds: 2, stopped: 'empty' });
    assert.deepEqual(out['msgr-avatars'], { removed: 1, rounds: 2, stopped: 'empty' });
    const dels = s.reqs.filter((r) => r.method === 'DELETE').map((r) => [r.url, r.body.prefixes]);
    assert.deepEqual(dels, [['/storage/v1/object/msgr', ['org/ch/1/a.pdf', 'p/ch/2/b.png']], ['/storage/v1/object/msgr-avatars', ['avatars/u1/me.jpg']]]);
    assert.ok(s.reqs.every((r) => r.auth === 'Bearer svc' && r.apikey === 'svc'), '서비스 역할로만');
  } finally { await s.close(); }
});

test('[버킷별] 한 버킷의 실패(402·후보 함수 없음)가 다른 버킷 정리를 막지 않고, 실패한 버킷은 한 번만 시도한다(다음 크론에 다시)', async () => {
  const s = await fakeSupabase({ lists: { msgr_storage_sweep_list: ['org/ch/1/a.pdf'], msgr_storage_sweep_avatars: ['avatars/u1/me.jpg'] }, fail: { msgr: 402 } });
  try {
    const out = await sweepBuckets({ url: s.url, service: 'svc' });
    assert.equal(out.msgr.stopped, 'remove_failed');
    assert.equal(out['msgr-avatars'].removed, 1);
    assert.equal(s.reqs.filter((r) => r.method === 'DELETE' && r.url.endsWith('/msgr')).length, 1, '실패한 버킷은 같은 실행에서 다시 보내지 않는다');
    assert.deepEqual(s.left.msgr_storage_sweep_list, ['org/ch/1/a.pdf'], '행이 남아 다음 크론 후보');
  } finally { await s.close(); }
  const old = await fakeSupabase({ lists: { msgr_storage_sweep_list: ['org/ch/1/a.pdf'] } }); // 마이그레이션 전 DB(아바타 후보 함수 없음)
  try {
    const out = await sweepBuckets({ url: old.url, service: 'svc' });
    assert.equal(out.msgr.removed, 1, '첨부 정리는 그대로');
    assert.equal(out['msgr-avatars'].stopped, 'list_failed');
  } finally { await old.close(); }
});

test('[유휴] 두 버킷 모두 후보가 없으면 목록 읽기만 하고 지우기 0', async () => {
  const s = await fakeSupabase({ lists: { msgr_storage_sweep_list: [], msgr_storage_sweep_avatars: [] } });
  try {
    await sweepBuckets({ url: s.url, service: 'svc' });
    assert.equal(s.reqs.filter((r) => r.method === 'DELETE').length, 0);
    assert.equal(s.reqs.length, 2);
  } finally { await s.close(); }
});
