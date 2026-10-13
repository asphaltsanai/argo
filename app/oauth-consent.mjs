// OAuth 동의 화면 넘김(2026-10-13 오피스 원격 MCP 연결) — 운영 Supabase의 Site URL이 http://localhost:3001이라
// OAuth 2.1 서버가 사용자를 이 본체의 /oauth/consent?authorization_id=…로 보낸다. 동의 화면은 오피스에 있으므로
// 쿼리를 그대로 붙여 오피스로 넘기기만 한다(본체에는 오피스 로직을 두지 않는다). next 무의존 순수 모듈 — 시험이 직접 부른다.
// 운영 오피스 주소 — 커넥터 카탈로그(src/market.mjs argo-office)의 url과 같은 출처.
export const OFFICE_CONSENT_URL = 'https://argo-office.vercel.app/oauth/consent';

/** 요청 주소 → 오피스 동의 화면 주소. 목적지는 고정이고 요청의 쿼리만 옮긴다(열린 리디렉트 아님). */
export function officeConsentTarget(reqUrl) {
  const target = new URL(OFFICE_CONSENT_URL);
  target.search = new URL(reqUrl).search;
  return target.toString();
}
