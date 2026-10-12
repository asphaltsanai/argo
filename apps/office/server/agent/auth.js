// 원격 MCP·대기 변경 실행의 인증 — 요청의 Bearer 토큰(Supabase Auth가 준 사용자 토큰: OAuth 2.1 접근 토큰 또는 오피스 화면 세션)을 Supabase에 물어 사용자를 확인하고,
// 그 토큰으로 움직이는 supabase-js 클라이언트를 만든다(서비스 키 없음 — 권한은 RLS·office_* 함수가 판정). 요청마다 새로 만든다(동시 요청이 섞이지 않게).
// env: VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY(다른 서버 함수와 같다) · OFFICE_ORIGIN(보호 자원 주소)
import { createClient } from '@supabase/supabase-js';

const env = process.env;
export const bearer = (request) => /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;

/** 토큰 → { client, uid, token } | null(없음·만료·거절). 사용자 확인 1회(/auth/v1/user) */
export async function sessionFor(token, { fetchImpl = fetch } = {}) {
  if (!token || !env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) return null;
  const r = await fetchImpl(`${env.VITE_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } }).catch(() => null);
  if (!r?.ok) return null;
  const uid = (await r.json().catch(() => ({})))?.id;
  if (typeof uid !== 'string' || !uid) return null;
  const client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    global: { headers: { authorization: `Bearer ${token}` }, fetch: fetchImpl },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { client, uid, token };
}

/** 이 오피스의 주소 — OFFICE_ORIGIN, 없으면 요청 주소 */
export const originOf = (request) => (env.OFFICE_ORIGIN || new URL(request.url).origin).replace(/\/+$/, '');
/** RFC 9728 보호 자원 메타데이터 — 인증 서버는 이 프로젝트의 Supabase Auth(OAuth 2.1 서버) */
export const resourceMetadata = (origin) => ({
  resource: `${origin}/api/mcp`,
  authorization_servers: [`${String(env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/auth/v1`],
  bearer_methods_supported: ['header'],
  resource_name: 'Argo Office',
});
export const metadataUrl = (origin) => `${origin}/.well-known/oauth-protected-resource/api/mcp`;
/** 401 — MCP 클라이언트가 이 머리글로 인증 서버를 찾는다 */
export const unauthorized = (origin) => new Response(JSON.stringify({ error: 'invalid_token' }), {
  status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': `Bearer resource_metadata="${metadataUrl(origin)}"` },
});
