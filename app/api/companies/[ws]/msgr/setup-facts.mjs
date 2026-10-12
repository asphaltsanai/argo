// 내 행이 하나도 없을 때(메신저에 에이전트가 안 나타남) 카드가 이유를 고를 사실 — 브리지 자동 켜기(src/gateway/msgr.mjs autoEnableMsgr)와 같은 조건을 쓴다.
// 행이 있으면 묻지 않는다: 그 경우 카드의 8초 폴이 돌 수 있어 조회를 늘리지 않게(행 0개면 폴이 돌지 않는다 — msgr-card.mjs msgrCardView polling).

/** → { owner, profile, bridge } 또는 null(행이 있음). profile = 이 계정으로 메신저에 로그인한 적 있음(msgr_profiles), 조회 실패면 null. 조직 멤버면 묻지 않는다(null). */
export async function setupFacts({ rows, orgCount, company, uid, hasProfile }) {
  if (rows.length) return null;
  return {
    owner: company?.ownerId === uid,
    profile: orgCount ? null : await hasProfile().then((v) => !!v, () => null),
    bridge: !!company?.msgr?.enabled,
  };
}

/** 행이 0개인 계정의 '지금 연결'(POST reconnect) — 'enable'(브리지를 켜고 깨운다 — 자동 켜기를 기다리지 않는다) | 'account'(메신저를 쓴 적 없는 계정) | 'owner'.
    자동 켜기와 같은 조건이다: 회사 소유자이고, 조직 멤버이거나 메신저 프로필이 있어야 한다. 프로필을 못 읽었으면(null) 켜지 않는다. */
export function zeroRowsReconnect({ owner, orgCount, profile }) {
  if (!owner) return 'owner';
  return orgCount > 0 || profile === true ? 'enable' : 'account';
}
