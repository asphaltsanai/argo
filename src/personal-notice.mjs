// 개인 공간 1:1 방 알림 — 에이전트가 대화(턴) 밖에서 주인의 개인 공간 1:1 방에 알림 글을 올린다(목표 하트비트 goal-heartbeat.mjs).
// 2026-10-13 오피스 완전 분리 때 능동 비서(src/assistant — 오피스 일정·메일 감시)를 지우며 그 배달 함수만 옮겼다 — 규칙은 그대로다.
// 받는 곳은 개인 공간 1:1 방(msgr_dm_personal_crew)**만**이다: 조직 1:1 경로는 보관한 방 대신 새 방을 만들고, 조직 채널의 에이전트 글은 자격 트리거가
// 'nt:' 접두만 빼 주므로 'as:' 글은 자격이 끝난 조직에서 거절된다. 같은 항목은 서버에서 한 번만 — client_msg_id = as:<에이전트 메신저 id>:<기준 sha256 앞 32자>
// (유니크: 채널·작성자 종류·작성자·client_msg_id). 표지 meta.notification 'assistant'와 접두 'as:'는 옛 글과 같게 둔다(알림 종류 끄기·자기 글 알아보기가 이 값을 본다).
import { createHash } from 'node:crypto';
import { channelSends } from './channel-events.mjs';
import { recordSelfPost } from './self-posts.mjs';

export const MSG_MAX = 20_000; // msgr_messages.body check 제약과 같다(gateway/msgr.mjs MSG_MAX)

export const clientMsgId = (crewId, basis) => `as:${crewId}:${createHash('sha256').update(String(basis)).digest('hex').slice(0, 32)}`;

const coded = (code, message) => Object.assign(new Error(message), { code });

/** 메신저 알림 종류에서 하트비트(코드 이름 assistant) 알림을 껐는가(순수) — 회사의 msgr.mutedEvents. */
export const heartbeatMuted = (company) => !channelSends('msgr', { enabled: true, mutedEvents: company?.msgr?.mutedEvents }, 'assistant');

/** 에이전트의 개인 공간 행과 그 1:1 방 — { crewId, channelId }. 개인 행(조직 없음·활성)이 없거나 방 RPC가 실패하면 던진다(code 'personal_room_unavailable').
    조직 1:1 방으로 물러나지 않는다. myCrews는 이 회사의 내 활성 행(개인·조직)이다(gateway/msgr.mjs makeDb). */
export async function personalRoom(c, wsId, slug) {
  const rows = await c.db.myCrews(c.uid, wsId);
  const crew = (rows ?? []).find((r) => r.org_id == null && r.slug === slug);
  if (!crew) throw coded('personal_room_unavailable', `no personal messenger row for ${slug}`);
  const { data, error } = await c.client.rpc('msgr_dm_personal_crew', { crew: crew.id });
  if (error || !data) throw coded('personal_room_unavailable', String(error?.message ?? 'msgr_dm_personal_crew: no room'));
  return { crewId: crew.id, channelId: data };
}

/** 글 넣기 — 'sent' | 'dup'. dup = 같은 client_msg_id가 이미 있다(같은 기기의 응답만 끊긴 재시도, 또는 다른 기기가 같은 항목을 먼저 넣음 — 23505를 insertMessage가 null로 돌려준다).
    그 밖 실패는 던진다. */
export async function insertNotice(c, room, ob) {
  const row = {
    channel_id: room.channelId, author_kind: 'crew', crew_id: room.crewId, kind: 'text', reply_to: null, thread_root: null,
    client_msg_id: clientMsgId(room.crewId, ob.basis), body: String(ob.body).slice(0, MSG_MAX), mentions: [],
    meta: { disposition: 'done', notification: 'assistant', assistant: ob.meta },
  };
  const ins = await c.db.insertMessage(row);
  if (!ins) return 'dup';
  // 개인 공간 1:1에 올린 자기 글 기록(self-posts.mjs) — 에이전트가 다음 주인 1:1 턴에서 '내가 보낸 알림'으로 알아본다. room.ws·room.slug가 있을 때만
  if (room.ws && room.slug) await recordSelfPost(room.ws, room.slug, row, { id: ins.id ?? null, personal: true, lang: room.lang ?? 'ko' });
  return 'sent';
}
