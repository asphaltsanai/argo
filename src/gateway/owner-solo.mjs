// 주인 혼자 1:1 방 판정(유건 결정 2026-10-08 ① — 에이전트는 한 사람). 메신저 게이트웨이(msgr.mjs)가 쓴다.
// 2026-10-13 오피스 분리 때 오피스 도구 모듈(gateway/office-audience.mjs)에서 옮겼다 — 판정 규칙은 그대로.

/** 주인 혼자 1:1 방인가(유건 결정 2026-10-08 ① — 에이전트는 한 사람). 방이 1:1(dm)이고 사람 구성원이 주인 하나이며,
    방의 에이전트도 이 에이전트 하나뿐이어야 한다는 조건을 더한다 — 다른 사람의 에이전트가 같은 방에 있으면 그 주인이 에이전트를 거쳐 방 글을 읽는다.
    비용: 방 구성원 조회 1건(사람·에이전트 한 번에). 모르면(오류·빈 결과) false — 좁게. */
export async function ownerSoloRoom(client, ctx, ownerId, crewId) {
  if (ctx?.channelKind !== 'dm' || !ctx?.channelId || !ownerId || !crewId) return false;
  try {
    const { data, error } = await client.from('msgr_channel_members').select('member_kind, member_id').eq('channel_id', ctx.channelId);
    if (error || !Array.isArray(data) || !data.length) return false;
    const of = (kind) => [...new Set(data.filter((r) => r.member_kind === kind).map((r) => r.member_id))];
    const users = of('user'); const crews = of('crew');
    return data.every((r) => r.member_kind === 'user' || r.member_kind === 'crew')
      && users.length === 1 && users[0] === ownerId && crews.length === 1 && crews[0] === crewId;
  } catch { return false; }
}
