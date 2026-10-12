// RFC 9728 보호 자원 메타데이터 — /.well-known/oauth-protected-resource(/api/mcp)가 여기로 온다(vercel.json rewrites). MCP 클라이언트가 인증 서버를 찾는 곳.
import { originOf, resourceMetadata } from '../server/agent/auth.js';

export function GET(request) {
  return new Response(JSON.stringify(resourceMetadata(originOf(request))), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' } }); }
