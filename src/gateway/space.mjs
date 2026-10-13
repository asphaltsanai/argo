// 공간 판정 기준 함수(유건 결정 2026-10-13 — 기억·공간 아키텍처 1단계). 순수 함수만, DB·세션 왕복 없음.
// 판정은 두 축으로 나눈다 —
//   대화 위치(chatLocation): 이 글이 어느 방에서 왔나. 채널 행(org_id·kind·personal_pair·crew_memory)만 본다.
//   작업 문맥(workContext): 이 턴이 어느 조직 권한으로 일하나. 턴 맥락(mirrorCtx.orgId = 크루 행의 조직)만 본다.
// 지금까지는 orgId 하나가 두 뜻(방이 개인 공간인가 / 어느 조직 자료를 쓰나)으로 겹쳐 쓰였다. 이 단계는 동작을 바꾸지 않는다 —
// 각 값은 흩어져 있던 기존 판정식과 같은 결과를 낸다(test/space-judge-matrix.test.mjs가 기존 식과 칸마다 대조한다).
// 손님·풀 오토·주인 혼자 1:1 판정은 msgr-handoff.mjs의 한 함수들(isGuestCtx·fullAutoAllowed·ownerSoloTurn)이 그대로 정본이다.

/** 대화 위치 종류 — 채널 행에서만 정한다 */
export const LOCATION = Object.freeze({
  NONE: 'none', // 채널 없음(삭제·조회 실패)
  ORG_PUBLIC: 'org-public', // 조직 공개 채널
  ORG_PRIVATE: 'org-private', // 조직 비공개 채널
  ORG_DM: 'org-dm', // 조직 1:1(주인↔에이전트, 사람↔사람 등 — 구성원은 이 함수가 보지 않는다)
  PERSONAL_CREW_DM: 'personal-crew-dm', // 개인 공간 내 에이전트 1:1(personal_pair = 'crew:<에이전트 id>')
  PERSONAL_FRIEND_DM: 'personal-friend-dm', // 개인 공간 친구 1:1(사람 짝 키)
  PERSONAL_GROUP: 'personal-group', // 개인 공간 그룹 방(조직 없는 공개·비공개 방)
});

/**
 * 대화 위치 — 채널 행 → 판정 묶음. 각 값은 그 값을 쓰던 기존 식과 같다(바꾸지 않는다):
 *  - deliveryDm: 멘션 없이도 모든 사람 글을 받는 DM(서버 msgr_delivery_target과 같은 규칙). 기존 msgr.mjs deliveryDm — org_id를 **엄격 비교**(!== null)한다.
 *  - relayDm: DM 전달 표지(meta.relay)를 인정하는 방 — 조직 DM만. 기존 msgr.mjs relayChannel(느슨한 비교 != null).
 *  - orgTopic: 입력 중·받음 방송을 조직 토픽으로 보내는가(공개 채널만). 기존 roomTopic/startTyping의 full.
 *  - sessionless: 채널 세션을 잇지 않는다(DM이거나 기억 안 남김). 기존 run·runMessengerContinuation의 sessionId 분기.
 *  - personal: 조직 없는 방인가(대화 위치 기준). 기존 `!ch.org_id`.
 *  - archived: 보관한 방(읽기 전용 — 옛 조직 1:1 보관, 1:1 하나로 합치기 2단계). 기존 `!!ch.archived_at`.
 */
export function chatLocation(ch) {
  if (!ch) return { kind: LOCATION.NONE, orgId: null, personal: false, dm: false, archived: false, deliveryDm: false, relayDm: false, orgTopic: false, sessionless: false, memoryOff: false };
  const orgId = ch.org_id ?? null;
  const dm = ch.kind === 'dm';
  const pair = String(ch.personal_pair ?? '');
  const kind = orgId
    ? (dm ? LOCATION.ORG_DM : ch.kind === 'public' ? LOCATION.ORG_PUBLIC : LOCATION.ORG_PRIVATE)
    : (dm ? (pair.startsWith('crew:') ? LOCATION.PERSONAL_CREW_DM : LOCATION.PERSONAL_FRIEND_DM) : LOCATION.PERSONAL_GROUP);
  const memoryOff = ch.crew_memory === false;
  return {
    kind, orgId, personal: !ch.org_id, dm, archived: !!ch.archived_at,
    deliveryDm: dm && (ch.org_id !== null || pair.startsWith('crew:')),
    relayDm: dm && ch.org_id != null,
    orgTopic: ch.kind === 'public',
    sessionless: dm || memoryOff,
    memoryOff,
  };
}

/** 턴 기록(appendTurn)의 문맥 표지 종류 — DM이면 'msgr-dm'(뿌리마다 새로 허가한 문맥), 그 밖은 'msgr'. 기존 run의 contextScope 분기. */
export const contextScopeKind = (ch) => (chatLocation(ch).dm ? 'msgr-dm' : 'msgr');

/**
 * 작업 문맥 — 턴 맥락(mirrorCtx·이어 실행 기록) → 어느 조직 권한으로 일하나. 메신저 턴(kind 'msgr')만 조직을 가진다.
 *  - orgId: 이 턴이 쓰는 조직(크루 행의 조직). 개인 공간 턴·메신저 밖 턴은 null.
 *  - personal: 메신저 턴인데 조직 권한이 없다(= 개인 공간 에이전트의 턴). 기존 messengerOrigin·stageMessengerHandoff·chat.mjs의 `!ctx.orgId`.
 *  - orgTools: 조직 자료(오피스 회사·문서함·할 일·거래)를 다룰 수 있는 턴. 기존 chat.mjs의 `kind === 'msgr' && orgId`.
 */
export function workContext(ctx) {
  const msgr = ctx?.kind === 'msgr';
  return { msgr, orgId: msgr && ctx.orgId ? ctx.orgId : null, personal: msgr && !ctx.orgId, orgTools: msgr && !!ctx.orgId };
}

/**
 * 턴 하나의 공간 판정 — 대화 위치와 작업 문맥을 같이 낸다. consistent = 두 축의 조직이 같다(조직 크루는 그 조직 방에서만, 개인 크루는 개인 방에서만 답한다 —
 * 봉투 경로는 envelope.channel.org_id !== job.orgId면 잡을 버린다). personalTurn = 두 축이 모두 개인(기존 run의 `!job.orgId && !ch.org_id`).
 */
export function judgeSpace({ channel = null, ctx = null } = {}) {
  const location = chatLocation(channel);
  const work = workContext(ctx);
  return { location, work, consistent: location.orgId === work.orgId, personalTurn: work.msgr && work.personal && location.personal };
}

/** 이어 실행 기록(messengerOrigin 반환)이 개인 갈래인가 — orgId 없음 + ownCrewRoom 표지. 표지는 운반용이라 실행 때 서버가 방을 다시 판정한다(restoreMessengerContext). */
export const personalOrigin = (origin) => origin?.orgId == null && origin?.ownCrewRoom === true;
