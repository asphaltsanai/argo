// 오피스 원격 MCP의 도구 목록과 실행기(2026-10-13 오피스 독립 앱 분리 — 유건 지시). HTTP 층은 api/mcp.js, 여기는 서버 없이 시험할 수 있는 순수 부분.
// 에이전트(Argo의 원격 MCP 커넥터·Claude Code·Codex 등)는 사용자 토큰(Supabase OAuth 2.1 접근 토큰)으로 붙는다. 권한은 그 토큰의 RLS·office_* 함수가 판정한다.
// 조직: 도구마다 org 인자(id·slug·이름). 비우면 속한 조직이 하나일 때 그 조직, 아니면 office_orgs로 고르라고 알린다(일정·메일·브리핑은 비우면 개인 공간).
// 쓰기: 바로 실행하지 않고 대기 변경(office_agent_actions)으로 올린다 — 사람이 오피스 화면에서 [실행]을 눌러야 실행된다(총괄 결정: 승인은 오피스 화면 한 곳).
// 그래서 모든 도구의 annotations는 readOnlyHint=true다 — 도구 호출 자체는 오피스 기록을 바꾸지 않는다(제안만 남긴다). 부른 쪽의 결재와 겹치지 않게.
import { z } from 'zod';
import { officeToolSpecs } from './tools.js';
import { remoteContext } from './audience.js';
import { isWrite, proposalSummary } from './actions.js';

/** 원격에서 열지 않는 동작 — 일정 삭제(되돌릴 수 없음, CLI와 같다), 문서함 올리기(서버가 에이전트 컴퓨터의 파일을 읽을 수 없다) */
export const BLOCKED = { calendar: ['delete'], office_files: ['attach'] };
/** 조직 없이도 쓰는 도구(개인 공간) */
export const PERSONAL = new Set(['calendar', 'office_mail', 'office_briefing']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inner = (s) => { let t = s; while (t?.def?.innerType || t?.unwrap) t = t.def?.innerType ?? t.unwrap(); return t; };
const say = (lang, ko, en) => (lang === 'en' ? en : ko);

export function remoteSpecs(lang = 'ko') {
  return officeToolSpecs(lang).map((spec) => {
    const blocked = BLOCKED[spec.name] ?? [];
    const actions = inner(spec.shape.action).options.filter((x) => !blocked.includes(x));
    const note = say(lang,
      `\n[아르고 오피스 원격 MCP] 쓰기 동작(만들기·고치기·보내기 준비)은 바로 실행되지 않고 '대기 변경'으로 올라간다 — 사용자가 아르고 오피스 화면에서 [실행]을 눌러야 실행된다. 올린 뒤에는 실행했다고 말하지 말고, 오피스에서 확인해 달라고 알려라. 조직은 org 인자(office_orgs가 보여 준 id·slug·이름).${blocked.length ? ` 여기서는 열지 않음: ${blocked.join(', ')}(아르고 오피스 화면에서).` : ''}`,
      `\n[Argo Office remote MCP] Write actions (create, update, prepare to send) do not run right away — they are filed as a pending change that runs only after the user presses Run in Argo Office. After filing, do not say it was done; ask the user to confirm it in Office. Pick the org with the org argument (id, slug or name from office_orgs).${blocked.length ? ` Not available here: ${blocked.join(', ')} (do it in Argo Office).` : ''}`);
    return { ...spec, description: spec.description + note, actions, blocked, shape: { ...spec.shape, action: z.enum(actions) } };
  });
}

/** 내가 속한 조직(손님 포함) — [{ id, name, slug, role }] */
export async function myOrgs(c) {
  const { data, error } = await c.client.from('msgr_org_members').select('role, org:msgr_orgs(id, name, slug, deleted_at)').eq('user_id', c.uid).is('removed_at', null);
  if (error) throw new Error(error.message);
  return (data ?? []).filter((m) => m.org && !m.org.deleted_at).map((m) => ({ id: m.org.id, name: m.org.name, slug: m.org.slug, role: m.role }));
}

/** org 인자 → 조직 id. 비우면 손님이 아닌 조직이 하나일 때 그 조직. 반환 { org } | { error } */
export async function resolveOrg(c, want, { personal = false, lang = 'ko' } = {}) {
  const w = String(want ?? '').trim();
  if (!w && personal) return { org: null };
  const orgs = (await myOrgs(c)).filter((o) => o.role !== 'guest');
  if (!w) {
    if (orgs.length === 1) return { org: orgs[0].id };
    return { error: say(lang, `조직을 골라야 한다 — org 인자에 office_orgs가 보여 준 id·slug·이름을 넣어라(속한 조직 ${orgs.length}곳).`, `Pick an org — pass the org argument (id, slug or name from office_orgs; you belong to ${orgs.length}).`) };
  }
  const hit = orgs.filter((o) => o.id === w || o.slug === w.toLowerCase() || o.name.toLowerCase() === w.toLowerCase());
  if (hit.length === 1) return { org: hit[0].id };
  if (!hit.length && UUID.test(w)) return { error: say(lang, '그 조직의 구성원이 아니다(손님은 오피스 기록을 다루지 않는다).', 'You are not a member of that org (guests do not use Office records).') };
  return { error: hit.length ? say(lang, `"${w}"에 맞는 조직이 여럿이다 — id를 써라.`, `"${w}" matches several orgs — use its id.`) : say(lang, `"${w}" 조직이 없다 — office_orgs를 보라.`, `No org "${w}" — see office_orgs.`) };
}

const ORG_ARG = z.string().optional().describe('조직 id·slug·이름(office_orgs). 비우면 속한 조직이 하나일 때 그 조직. 일정·메일·브리핑은 비우면 개인 공간');
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** 도구 목록(JSON 스키마)과 실행기. c = { client(사용자 토큰의 supabase-js), uid, token }, source = 부른 클라이언트 이름(대기 변경·쓰기 기록의 출처) */
export function officeMcp({ lang = 'ko' } = {}) {
  const specs = remoteSpecs(lang);
  const tools = [
    ...specs.map((s) => ({ name: s.name, description: s.description, inputSchema: z.toJSONSchema(z.object({ ...s.shape, org: ORG_ARG })), annotations: READ_ONLY })),
    { name: 'office_orgs', description: say(lang, '내가 속한 아르고 오피스 조직 목록(id·이름·slug·역할).', 'List my Argo Office organizations (id, name, slug, role).'), inputSchema: z.toJSONSchema(z.object({})), annotations: READ_ONLY },
    { name: 'office_actions', description: say(lang, '내가 올린 대기 변경 목록과 처리 결과(대기 중·실행함·실패·취소). 사용자가 오피스에서 처리했는지 확인할 때.', 'My pending changes and their outcome (pending, done, failed, canceled) — to check whether the user handled them in Office.'), inputSchema: z.toJSONSchema(z.object({})), annotations: READ_ONLY },
  ];
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

  async function call(name, rawArgs, { c, source = 'MCP' }) {
    if (name === 'office_orgs') return text(JSON.stringify(await myOrgs(c)));
    if (name === 'office_actions') {
      const { data, error } = await c.client.rpc('office_agent_action_list');
      if (error) return text(error.message, true);
      return text(JSON.stringify((data ?? []).slice(0, 30).map(({ id, tool, action, summary, status, result, created_at }) => ({ id, tool, action, summary, status, ...(result ? { result: String(result).slice(0, 300) } : {}), created_at }))));
    }
    const spec = specs.find((s) => s.name === name);
    if (!spec) return text(`unknown tool: ${name}`, true);
    const { org: orgWant, ...args } = rawArgs ?? {};
    const parsed = z.object(spec.shape).safeParse(args);
    if (!parsed.success) return text(parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('\n'), true);
    const a = parsed.data;
    const o = await resolveOrg(c, orgWant, { personal: PERSONAL.has(spec.name), lang });
    if (o.error) return text(o.error, true);
    if (isWrite(spec.name, a)) {
      const summary = proposalSummary(spec.name, a, lang).slice(0, 300);
      const { data: id, error } = await c.client.rpc('office_agent_action_add', { p_org: o.org, p_tool: spec.name, p_action: a.action, p_args: a, p_summary: summary, p_source: String(source).slice(0, 120) });
      if (error) {
        const limit = /agent_action_limit/.test(error.message);
        return text(limit ? say(lang, '대기 변경이 50개 쌓여 더 올리지 않았다 — 사용자에게 오피스에서 먼저 처리해 달라고 알려라.', '50 pending changes are waiting, so this was not filed — ask the user to handle them in Office first.')
          : say(lang, `대기 변경을 올리지 못했다: ${error.message.slice(0, 200)}`, `Could not file the pending change: ${error.message.slice(0, 200)}`), true);
      }
      return text(say(lang, `실행하지 않고 대기 변경으로 올렸다(id ${id}): ${summary}\n사용자가 아르고 오피스에서 [실행]을 누르면 그때 실행된다. 실행했다고 말하지 말고, 오피스에서 확인해 달라고 짧게 알려라.`,
        `Not executed — filed as a pending change (id ${id}): ${summary}\nIt runs when the user presses Run in Argo Office. Do not say it was done; briefly ask them to confirm it in Office.`));
    }
    return text(await runSpec(spec, a, { c, org: o.org, source, lang }));
  }
  return { tools, call };
}

/** 도구 하나를 그 사용자의 세션으로 실행한다 — 읽기(MCP)와 대기 변경 [실행](api/agent-actions.js)이 같이 쓴다. 반환: 처리기가 돌려준 글 */
export async function runSpec(spec, args, { c, org = null, source = 'MCP', lang = 'ko', approved = false }) {
  const ctx = remoteContext({ uid: c.uid, orgId: org, source: { kind: 'session', name: String(source).slice(0, 120) }, session: async () => c, jwt: async () => c.token, approved });
  return String(await spec.run(args, { ctx, crew: null, crewName: String(source).slice(0, 120), lang, ownerId: c.uid }));
}

/** 이름으로 실행용 정의 찾기 — 막은 동작(BLOCKED)은 [실행]으로도 돌지 않는다 */
export function specFor(name, action, lang = 'ko') {
  const spec = remoteSpecs(lang).find((s) => s.name === name);
  return spec && spec.actions.includes(action) ? spec : null;
}
