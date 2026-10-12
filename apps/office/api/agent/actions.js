// 대기 변경 [실행](2026-10-13 오피스 분리) — 오피스 화면에서 사람이 누른다. 요청자의 오피스 세션 토큰으로만 움직인다(서비스 키 없음).
// 흐름: 잡기(office_agent_action_claim — 대기 중인 내 행만, 두 번 눌러도 한 번) → 그 행의 도구·인자를 요청자 세션으로 한 번 실행 → 결과 적기(finish).
// 목록·취소는 화면이 RPC(office_agent_action_list·cancel)를 바로 부른다. 부하: 누를 때만 — 서버 함수 1회 + RPC 2회 + 도구가 부르는 RPC.
import { bearer, sessionFor } from '../../server/agent/auth.js';
import { specFor, runSpec } from '../../server/agent/mcp.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 처리기는 거절·오류도 한 줄 글로 돌려준다 — 그 글을 결과로 남기고, 던진 오류만 실패로 */
export async function run(request, deps = {}) {
  const c = await (deps.sessionFor ?? sessionFor)(bearer(request), { kind: 'user' }); // 오피스 화면 세션만 — OAuth 클라이언트 토큰은 [실행]하지 못한다(검수 2 HIGH-1)
  if (!c) return json({ error: 'signed_out' }, 401);
  const body = await request.json().catch(() => ({}));
  if (!UUID.test(String(body?.id ?? ''))) return json({ error: 'input' }, 400);
  const lang = body.lang === 'en' ? 'en' : 'ko';
  const { data: row, error } = await c.client.rpc('office_agent_action_claim', { p_id: body.id });
  if (error) return json({ error: 'db', message: error.message.slice(0, 200) }, 502);
  if (!row) return json({ error: 'not_pending' }, 409);
  const spec = specFor(row.tool, row.action, lang);
  let ok = true, result;
  if (!spec) { ok = false; result = lang === 'en' ? 'This action is not available.' : '이 동작은 실행할 수 없습니다.'; }
  else {
    try { result = await (deps.runSpec ?? runSpec)(spec, row.args, { c, org: row.org_id ?? null, source: row.source, lang, approved: true }); } // 사람이 오피스 화면에서 승인한 실행 — 주인 자리(audience.js)
    catch (e) { ok = false; result = String(e?.message ?? e).slice(0, 500); }
  }
  await c.client.rpc('office_agent_action_finish', { p_id: row.id, p_ok: ok, p_result: String(result ?? '').slice(0, 4000) });
  return json({ id: row.id, status: ok ? 'done' : 'failed', result });
}

const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
function cors(request, response) {
  const source = request.headers.get('origin');
  response.headers.set('vary', 'Origin');
  if (DESKTOP_ORIGINS.has(source)) {
    response.headers.set('access-control-allow-origin', source);
    response.headers.set('access-control-allow-methods', 'POST, OPTIONS');
    response.headers.set('access-control-allow-headers', 'Authorization, Content-Type');
  }
  return response;
}
export async function POST(request) { return cors(request, await run(request)); }
export async function OPTIONS(request) { return cors(request, new Response(null, { status: DESKTOP_ORIGINS.has(request.headers.get('origin')) ? 204 : 403 })); }
