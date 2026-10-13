// 연결 도구가 서버의 재시도 시각을 따른다(2026-10-13 — Hermes 0.3.7·OpenClaw 0.3.4). 서버(msgr-bot)는 무료 주인 403·무효 토큰 401·429에
// parameters.retry_after와 HTTP Retry-After를 싣는다(test/msgr-bot-reject-memory.test.mjs). 잠그는 것:
//   ① 본문 retry_after가 먼저, 없으면 Retry-After 헤더, 양수만, 상한 1시간  ② 받기 거부에 retry_after가 있으면 사다리 대신 그만큼 쉰다
//   ③ 401은 종전처럼 멈춘다(재시도하지 않는다)  ④ OpenClaw — 긴 대기 중 중단 신호면 타이머를 지우고 바로 나온다(종료를 붙잡지 않는다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeApi, pollLoop, retryAfterOf, RETRY_AFTER_MAX_S } from '../integrations/openclaw-argo-msgr/src/api.js';

const T = 'argo_bot_' + 'b'.repeat(48);
// fetch 대역 — getUpdates 응답을 차례로 준다. headers.get은 Retry-After만
const fetchSeq = (seq) => { let i = 0; return async () => { const { status = 200, body, retryAfter = null } = seq[Math.min(i++, seq.length - 1)]; return { status, ok: status < 400, headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) }, json: async () => body }; }; };
const plan403 = (params) => ({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: external agent connections need Argo Pro', ...(params ? { parameters: params } : {}) } });
const unauth = { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized: bad or revoked bot token' } };

test('① OpenClaw retryAfterOf — 본문이 먼저, 헤더 다음, 양수만, 상한 1시간', () => {
  assert.equal(retryAfterOf({ parameters: { retry_after: 300 } }, '10'), 300);
  assert.equal(retryAfterOf({}, '120'), 120);
  assert.equal(retryAfterOf({ parameters: { retry_after: 0 } }, null), null);
  assert.equal(retryAfterOf({ parameters: { retry_after: 'x' } }, '-5'), null);
  assert.equal(retryAfterOf({ parameters: { retry_after: 99_999 } }, null), RETRY_AFTER_MAX_S);
});

test('② ③ OpenClaw pollLoop — retry_after가 있으면 그만큼(본문·헤더) 쉬고, 없으면 종전 사다리, 401이면 멈춘다', async () => {
  const sleeps = []; const logs = [];
  const f = fetchSeq([plan403({ retry_after: 300 }), { ...plan403(null), retryAfter: '900' }, plan403(null), unauth]);
  await pollLoop(makeApi({ url: 'https://x', token: T, fetchImpl: f }), { onMessage: () => {}, log: (s) => logs.push(s), sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [300_000, 900_000, 1000], '본문 300초 → 헤더 900초 → 값 없음은 종전 1초 사다리');
  assert.match(logs.at(-1), /token rejected/);
});

test('④ OpenClaw — 긴 대기(300초) 중 중단 신호면 바로 나온다(기본 대기 함수, 타이머를 지운다)', async () => {
  const ac = new AbortController();
  const f = fetchSeq([plan403({ retry_after: 300 })]);
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 30);
  await pollLoop(makeApi({ url: 'https://x', token: T, fetchImpl: f }), { onMessage: () => {}, signal: ac.signal });
  assert.ok(Date.now() - t0 < 5_000, `${Date.now() - t0}ms`); // 타이머가 남으면 이 파일이 300초 동안 끝나지 않는다
});

test('①~③ Hermes — _retry_after 해석, 받기 거부의 retry_after만큼 쉬기, 401은 멈춤', () => {
  const script = String.raw`
import asyncio, importlib.util, sys, types
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
class Box:
    def __init__(self, **kw): self.__dict__.update(kw)
class Base:
    def __init__(self, **kw): pass
b = sys.modules['gateway.platforms.base']
b.BasePlatformAdapter = Base; b.MessageEvent = b.SendResult = Box; b.MessageType = Box(TEXT='text')
spec = importlib.util.spec_from_file_location('argo_adapter', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
R = m._retry_after
assert R({'parameters': {'retry_after': 300}}, '10') == 300
assert R({}, '120') == 120
assert R({'parameters': {'retry_after': 0}}, None) is None
assert R({'parameters': {'retry_after': 'x'}}, '-5') is None
assert R({'parameters': {'retry_after': 99999}}, None) == 3600
slept = []
async def fake_sleep(s): slept.append(s)
m.asyncio.sleep = fake_sleep
a = m.ArgoMsgrAdapter(Box(extra={}))
a._running = True; a._offset = 0
async def noop(): pass
a._flush_outbox = noop
seq = [m.ArgoMsgrError(403, 'need pro', 300.0), m.ArgoMsgrError(403, 'need pro', None), m.ArgoMsgrError(401, 'bad token', 900.0)]
async def api(method, params=None, **kw):
    raise seq.pop(0)
a._api = api
fatal = []
a._set_fatal_error = lambda *x, **k: fatal.append(x)
a._mark_disconnected = lambda: None
asyncio.run(a._poll_loop())
assert slept[0] == 300.0, slept
assert len(slept) == 2 and slept[1] <= 30, slept
assert fatal and fatal[0][0] == 'auth', fatal
assert a._running is False
print('ok')
`;
  const r = spawnSync('python3', ['-c', script, fileURLToPath(new URL('../integrations/hermes-argo-msgr/adapter.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});
