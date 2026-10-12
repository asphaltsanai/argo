// 본체 설정 '메신저 연결' 라우트(app/api/companies/[ws]/msgr/route.js)를 실제로 돌리는 자식 프로세스 — 세션·회사 설정·DB만 대역으로 바꾼다.
// 실행: node --experimental-test-module-mocks --no-warnings test/helpers/msgr-route-harness.mjs  (입력은 env ARGO_MSGR_HARNESS = JSON)
// 입력 { ownerId(회사 소유자 — 기본 이 계정), crews: [행], agents: [이 회사 에이전트 slug — 행이 없는 것까지], pauseReason, minApp: 'new'|'old', enabled, method, body, auto: true(이어서 진짜 autoEnableMsgr 한 번) }
// 출력(stdout 마지막 줄 JSON) { status, body(응답 JSON), enabled, rows: ['slug:status'], auto, log }
// DB 대역은 PostgREST가 select 열 목록대로만 돌려주는 것까지 흉내 내지 않는다 — 라우트가 읽는 열(id·org_id·slug·status·hosting)은 행에 늘 있다.
import { mock } from 'node:test';

const input = JSON.parse(process.env.ARGO_MSGR_HARNESS ?? '{}');
const at = (p) => new URL(`../../${p}`, import.meta.url).href;
const real = await import(at('src/gateway/msgr.mjs')); // 진짜 autoEnableMsgr·appMeetsMin·APP_VERSION
const UID = '11111111-1111-1111-1111-111111111111', WS = 'ws1';
const MIN = input.minApp === 'old' ? '999.0.0' : real.APP_VERSION; // old = 이 앱이 서버 최소 버전 미만
const crews = (input.crews ?? []).map((r, i) => ({ id: `id-${i}`, owner_user_id: UID, ws_id: WS, hosting: 'local', allow: 'owner', allow_users: [], org_id: null, ...r }));
let pauseReason = input.pauseReason ?? null;
const log = [];

function from(table) {
  const f = []; let patch = null, del = false, put = null, one = false;
  const b = {
    select() { return b; }, eq(k, v) { f.push((r) => r[k] === v); return b; }, neq(k, v) { f.push((r) => r[k] !== v); return b; },
    is(k, v) { f.push((r) => (r[k] ?? null) === v); return b; }, not(k, _op, v) { f.push((r) => (r[k] ?? null) !== v); return b; },
    in(k, vs) { f.push((r) => vs.includes(r[k])); return b; }, limit() { return b; },
    update(p) { patch = p; return b; }, delete() { del = true; return b; }, single() { one = true; return b; },
    insert(row) { put = row; return b; }, upsert(row) { put = row; return b; }, // 서버 관문 흉내: 새 행은 그대로 들어간다(이 시험의 계정은 Pro·연결 가능 상태)
    then(res, rej) {
      if (put) { const same = crews.find((r) => r.org_id === put.org_id && r.slug === put.slug); const row = same ?? { id: `id-${crews.length}`, ...put }; if (same) Object.assign(same, put); else crews.push(row);
        return Promise.resolve({ data: one ? { id: row.id, status: row.status } : null, error: null }).then(res, rej); }
      const rows = table === 'msgr_crews' ? crews.filter((r) => f.every((fn) => fn(r))) : [];
      if (patch) for (const r of rows) { if (patch.status === 'active' && pauseReason) continue; Object.assign(r, patch); } // 서버 관문 흉내: 새 앱 심박 전에는 사람의 연결도 paused로 남는다
      if (del) for (const r of rows) crews.splice(crews.indexOf(r), 1);
      return Promise.resolve({ data: patch || del ? null : rows.map((r) => ({ ...r })), error: null }).then(res, rej);
    },
  };
  return b;
}
const client = {
  from,
  async rpc(name, args) {
    if (name === 'msgr_my_agent_pause') { const paused = crews.filter((r) => r.status === 'paused').length; return { data: { paused, active: crews.filter((r) => r.status === 'active').length, limit: 4, reason: paused ? pauseReason : null, min_app: MIN }, error: null }; }
    if (name === 'msgr_free_keep') { // 실제 함수(20261012130000)처럼 새 앱이 없으면(app·off) 오류 — 라우트는 오류를 돌려주고 브리지 값을 쓰지 않는다
      if (pauseReason === 'app' || pauseReason === 'off') return { data: null, error: { code: 'P0001', message: 'msgr_app_update_required msgr_pro_required' } };
      const keep = args.p_keep.map((k) => k.split(':')[1]); for (const r of crews) if (r.status === 'active' || r.status === 'paused') r.status = keep.includes(r.slug) ? 'active' : 'paused'; log.push(`free_keep:${keep}`); return { data: { ok: true }, error: null }; }
    if (name === 'msgr_agent_swap_notes') return { data: [], error: null };
    return { data: null, error: null };
  },
};
const db = {
  heartbeat: async () => { log.push('heartbeat'); if (input.minApp !== 'old') { pauseReason = null; crews.filter((r) => r.status === 'paused').slice(0, 4).forEach((r) => { r.status = 'active'; }); } },
  myOrgIds: async () => [...new Set(crews.map((r) => r.org_id).filter(Boolean))], hasAnyCrew: async () => crews.length > 0, hasMsgrProfile: async () => true,
  hasPausedCrew: async () => crews.some((r) => r.status === 'paused'), myAgentPause: async () => (await client.rpc('msgr_my_agent_pause')).data,
};
const sess = { uid: UID, client, db };
let company = { id: WS, ownerId: input.ownerId ?? UID, msgr: { enabled: input.enabled ?? true } };
const update = async (_ws, fn) => { company = { ...company, ...fn(company) }; log.push(`enabled=${company.msgr.enabled}`); return company; };

// namedExports — CI(Node 22)가 아는 이름. Node 24는 exports를 권하지만 둘 다 받는다
mock.module(at('src/workspace.mjs'), { namedExports: { loadCompany: async () => structuredClone(company), updateCompany: update, getDeviceId: async () => 'dev1' } });
mock.module(at('app/auth.mjs'), { namedExports: { guardCompany: async () => null, csrfDenied: async () => null, authError: (code) => Response.json({ ok: false, code }, { status: 401 }), requestLang: async () => 'ko' } });
mock.module(at('src/gateway/msgr.mjs'), { namedExports: { sessionClient: async () => sess, appMeetsMin: real.appMeetsMin } });
mock.module(at('src/hub.mjs'), { namedExports: { listAgents: async () => [...new Set([...(input.agents ?? []), ...crews.map((r) => r.slug)])].map((slug) => ({ slug, name: slug })) } });
mock.module(at('src/connections.mjs'), { namedExports: { msgrGatewayStatus: async () => null, msgrRuntimeState: () => ({ state: 'waiting' }) } });
mock.module(at('src/gateway.mjs'), { namedExports: { nudgeGateway: () => {} } });

const route = await import(at('app/api/companies/[ws]/msgr/route.js'));
const res = await route[input.method ?? 'POST'](new Request('http://127.0.0.1/api', { method: input.method ?? 'POST', body: JSON.stringify(input.body ?? {}), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ ws: WS }) });
let auto = null;
if (input.auto) { // 게이트웨이의 10분 자동 켜기 한 번(진짜 함수) — 꺼진 브리지를 되살리는가
  let t = 0;
  auto = await real.autoEnableMsgr(WS, { company: structuredClone(company), session: async () => sess, load: async () => structuredClone(company), update, now: () => (t += 11 * 60_000), probes: new Map(), orgCache: new Map(), log: () => {} });
}
const body = await res.json().catch(() => null);
console.log(JSON.stringify({ status: res.status, body, enabled: company.msgr.enabled, rows: crews.map((r) => `${r.slug}:${r.status}`), auto, log }));
