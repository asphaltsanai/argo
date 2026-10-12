// 대기 변경(2026-10-13 오피스 독립 앱 분리) — 에이전트가 오피스 원격 MCP(api/mcp.js)로 부른 쓰기는 바로 실행되지 않고 office_agent_actions에 올라온다.
// 여기서 사람이 보고 [실행](오피스 서버가 이 사람의 세션으로 한 번 실행 — api/agent/actions.js)하거나 [취소]한다. 승인은 오피스 화면 한 곳(총괄 결정).
// 부하: 목록은 패널을 열 때·에이전트 답이 올 때·누른 뒤에만 읽는다(주기 호출 없음).
const getClient = async () => (await import('./supabase.js')).getClient(); // 쓸 때만 — 시험(node)이 Vite 설정 없이 순수 함수를 부를 수 있게
const apiUrl = async (p) => (await import('./platform.js')).apiUrl(p);

import { proposalSummary } from '../../server/agent/actions.js'; // 카드 한 줄은 저장된 요약이 아니라 실행될 인자로 다시 만든다(검수 2 HIGH-1 — 요약을 꾸며 다른 일을 승인받지 못하게)

export const STATUSES = ['pending', 'running', 'done', 'failed', 'canceled'];

/** 화면용 행 — 모양이 맞는 것만, 상태는 아는 값만 */
export const cleanActions = (list, lang = 'ko') => (Array.isArray(list) ? list : []).filter((a) => a && typeof a.id === 'string' && typeof a.tool === 'string')
  .map((a) => { const args = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {}; return { id: a.id, tool: String(a.tool ?? ''), action: String(a.action ?? ''), summary: proposalSummary(a.tool, { ...args, action: a.action }, lang), args,
    source: String(a.source ?? ''), status: STATUSES.includes(a.status) ? a.status : 'pending', result: a.result ? String(a.result) : '', at: a.created_at ?? null }; });
export const pendingOf = (list) => list.filter((a) => a.status === 'pending');

/** '자세히' — 실행될 인자를 칸 이름과 값 한 줄씩(action 제외). 길면 자른다. 무엇이 바뀌는지 보고 누르게 */
export function actionFields(a, max = 300) {
  const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  return Object.entries(a?.args ?? {}).filter(([k, v]) => k !== 'action' && v != null && v !== '')
    .map(([k, v]) => { const s = text(v); return { key: k, tool: a.tool, value: s.length > max ? `${s.slice(0, max)}…` : s }; });
}
/** 칸 이름 사전 키 — 도구마다 뜻이 다른 칸(메일 account = 메일 계정, 거래 account = 계좌)은 도구 키가 먼저 */
export function fieldLabelKey(f, has) {
  const own = `agent.field.${f.tool}.${f.key}`;
  return has(own) ? own : `agent.field.${f.key}`;
}

export async function listActions(sb = null, lang = 'ko') {
  const c = sb ?? await getClient();
  const { data, error } = await c.rpc('office_agent_action_list');
  if (error) throw error;
  return cleanActions(data, lang);
}
export async function cancelAction(id, sb = null) {
  const c = sb ?? await getClient();
  const { data, error } = await c.rpc('office_agent_action_cancel', { p_id: id });
  if (error) throw error;
  return data === true;
}
/** [실행] — 서버가 이 사람의 세션으로 한 번 실행한다. 반환 { status: 'done'|'failed', result } — 이미 처리된 행이면 { status: 'gone' } */
export async function runAction(id, lang = 'ko', { sb = null, fetchImpl = fetch } = {}) {
  const c = sb ?? await getClient();
  const jwt = (await c?.auth.getSession())?.data.session?.access_token;
  const r = await fetchImpl(await apiUrl('/api/agent/actions'), { method: 'POST', headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify({ id, lang }) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 409) return { status: 'gone' };
  if (!r.ok) throw Object.assign(new Error(d.error ?? 'actions'), { status: r.status });
  return { status: d.status === 'done' ? 'done' : 'failed', result: String(d.result ?? '') };
}
