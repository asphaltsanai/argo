// 아르고 오피스 원격 MCP(Streamable HTTP, 상태 없음 — 요청마다 서버를 새로 만든다). 2026-10-13 오피스 독립 앱 분리(유건 지시).
// 붙는 법: Argo는 원격 MCP 커넥터(OAuth 2.1 — Supabase Auth, 자동 등록)로, Claude Code는 `claude mcp add --transport http argo-office <오피스>/api/mcp`.
// 도구·쓰기 대기열 규칙은 server/agent/mcp.js. 이 파일은 인증(401 + 보호 자원 메타데이터 주소)과 전송만.
// 부하: 도구 호출 1회 = 서버 함수 1회 + 사용자 확인 1회(/auth/v1/user) + 도구가 부르는 RPC. 주기 호출 없음.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bearer, sessionFor, originOf, unauthorized } from '../server/agent/auth.js';
import { officeMcp } from '../server/agent/mcp.js';

const CLIENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', 'codex-mcp-client': 'Codex', 'argo-connector': 'Argo' };

export async function handle(request, deps = {}) {
  const origin = originOf(request);
  const c = await (deps.sessionFor ?? sessionFor)(bearer(request), { kind: 'mcp' }); // 허용 목록 OAuth 클라이언트 토큰만(auth.js)
  if (!c) return unauthorized(origin);
  const lang = /^en\b/i.test(request.headers.get('accept-language') ?? '') ? 'en' : 'ko';
  const mcp = officeMcp({ lang });
  const server = new Server({ name: 'argo-office', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcp.tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const who = server.getClientVersion()?.name ?? '';
    try { return await mcp.call(params.name, params.arguments ?? {}, { c, source: CLIENT_NAMES[who] || who || 'MCP' }); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e).slice(0, 500) }] }; }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request); } finally { await server.close().catch(() => {}); }
}

export const POST = (request) => handle(request);
export const GET = (request) => handle(request);
export const DELETE = (request) => handle(request);
