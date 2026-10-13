// 공간 판정 행렬 시험(유건 결정 2026-10-13 — 기억·공간 아키텍처 1단계). "공간 종류 × 판정"을 칸마다 잠근다.
// 이 단계는 동작을 바꾸지 않는다 — 기대값은 판정 함수(src/gateway/space.mjs)를 들이기 전 코드의 실제 결과다.
//  1) 대화 위치: 채널 행 → 종류·DM 수신·전달 표지·방송 토픽·세션·기록 표지. 흩어져 있던 기존 식(아래 OLD — 옮기기 전 원문 그대로)과 칸마다 대조한다.
//  2) 턴 판정: 공간 13종 × 행위자 8종 = 104칸. 개인 턴·축 일치·조직 도구·손님·풀 오토·주인 혼자 1:1·결재/예약 기록(자기·남)·방 밖 넘김.
// 결함으로 보이는 칸도 고치지 않고 표시만 한다(SUSPECT) — 고치는 것은 다음 단계 PR이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatLocation, contextScopeKind, judgeSpace, workContext, personalOrigin, LOCATION } from '../src/gateway/space.mjs';
import { isGuestCtx, fullAutoAllowed, ownerSoloTurn, messengerOrigin, stageMessengerHandoff } from '../src/gateway/msgr-handoff.mjs';

const UID = 'u-owner', FRIEND = 'u-friend', ORG = 'org-1', WS = 'ws';
// 공간 — ch = 채널 행, crewOrg = 답하는 크루 행의 조직(작업 문맥), own = 서버 msgr_is_own_crew_room 판정(개인 방에서 손님이 아닐 때만 묻는다, null = 모름)
const SPACES = {
  'org-public': { ch: { id: 'ch', org_id: ORG, kind: 'public', personal_pair: null, crew_memory: true }, crewOrg: ORG },
  'org-private': { ch: { id: 'ch', org_id: ORG, kind: 'private', personal_pair: null, crew_memory: true }, crewOrg: ORG },
  'org-dm': { ch: { id: 'ch', org_id: ORG, kind: 'dm', personal_pair: null, crew_memory: true }, crewOrg: ORG },
  'org-dm-memoff': { ch: { id: 'ch', org_id: ORG, kind: 'dm', personal_pair: null, crew_memory: false }, crewOrg: ORG },
  'org-public-memoff': { ch: { id: 'ch', org_id: ORG, kind: 'public', personal_pair: null, crew_memory: false }, crewOrg: ORG },
  'personal-crew-dm': { ch: { id: 'ch', org_id: null, kind: 'dm', personal_pair: 'crew:c1', crew_memory: true }, crewOrg: null, own: true },
  'personal-friend-dm': { ch: { id: 'ch', org_id: null, kind: 'dm', personal_pair: 'u-owner:u-friend', crew_memory: true }, crewOrg: null, own: false },
  'personal-group': { ch: { id: 'ch', org_id: null, kind: 'private', personal_pair: null, crew_memory: true }, crewOrg: null, own: false },
  'personal-dm-nopair': { ch: { id: 'ch', org_id: null, kind: 'dm', personal_pair: null, crew_memory: true }, crewOrg: null, own: false },
  // SUSPECT(도달 불가) — org_id 열이 빠진 채널 행. DB 행에는 늘 열이 있다. deliveryDm은 엄격 비교라 조직 DM으로, 나머지는 개인으로 본다(두 식이 갈린다)
  'dm-org-missing': { ch: { id: 'ch', kind: 'dm' }, crewOrg: null, own: null },
  // SUSPECT(봉투 경로에선 잡을 버림) — 두 축 불일치. 봉투 없는 옛 서버 경로만 도달한다(run의 envelope.channel.org_id !== job.orgId 가드)
  'mismatch-orgcrew-personalroom': { ch: { id: 'ch', org_id: null, kind: 'dm', personal_pair: 'crew:c1', crew_memory: true }, crewOrg: ORG },
  'mismatch-personalcrew-orgroom': { ch: { id: 'ch', org_id: ORG, kind: 'dm', personal_pair: null, crew_memory: true }, crewOrg: null, own: false },
  none: { ch: null, crewOrg: ORG },
};
// 행위자 — 턴 맥락의 요청자 사슬(게이트웨이 drain·run이 만드는 값)
const ACTORS = {
  owner: { origin: UID },
  'owner-solo': { origin: UID, ownerSolo: true }, // ownerSolo 표지는 게이트웨이가 방 구성원을 확인한 뒤에만 싣는다(ownerSoloRoom) — 여기서는 표지가 있을 때 턴 규칙만 본다
  guest: { origin: FRIEND },
  'guest-chain': { origin: UID, guest: true },
  'handoff-own': { origin: UID, rootAuthor: UID, handoffFrom: 'c2' },
  'handoff-guest-root': { origin: UID, rootAuthor: FRIEND, handoffFrom: 'c2' },
  office: { origin: UID, office: true },
  'no-origin': { origin: null },
};
const peers = [{ id: 'c1', slug: 'self', owner_user_id: UID, ws_id: WS, display_name: '나' }, { id: 'c2', slug: 'peer', owner_user_id: UID, ws_id: WS, display_name: '동료' }];

// 옮기기 전 원문 — 각 판정 지점의 식을 그대로 옮겨 적었다(대조 기준). 판정 함수가 이와 하나라도 다르면 이 시험이 실패한다.
const OLD = {
  deliveryDm: (ch) => ch?.kind === 'dm' && (ch.org_id !== null || String(ch.personal_pair ?? '').startsWith('crew:')), // msgr.mjs deliveryDm
  relayChannel: (c) => c?.kind === 'dm' && c.org_id != null, // msgr.mjs relayChannel
  orgTopic: (ch) => ch?.kind === 'public', // msgr.mjs run — roomTopic·startTyping의 full
  sessionless: (ch) => ch?.kind === 'dm' || ch?.crew_memory === false, // msgr.mjs run·runMessengerContinuation sessionId 분기
  scope: (ch) => (ch?.kind === 'dm' ? 'msgr-dm' : 'msgr'), // msgr.mjs run contextScope
  personalRoom: (ch) => !ch?.org_id, // msgr.mjs run `!ch.org_id`
  personalTurn: (job, ch) => !job.orgId && !ch.org_id, // msgr.mjs run 개인 턴(ownCrewRoom을 묻는 자리)
  personalWork: (ctx) => !ctx.orgId, // msgr-handoff messengerOrigin·stageMessengerHandoff, chat.mjs 743
  orgTools: (ctx) => ctx?.kind === 'msgr' && !!ctx.orgId, // chat.mjs 오피스 도구 싣기
  personalOrigin: (origin) => origin?.orgId == null && origin?.ownCrewRoom === true, // msgr.mjs restoreMessengerContext
};

// 대화 위치 기대값 — 종류 · 개인 방 · DM 수신(멘션 없이) · 전달 표지 인정 · 조직 토픽 방송 · 세션 없음 · 기록 표지
const LOCATION_EXPECTED = {
  'org-public': ['org-public', 0, 0, 0, 1, 0, 'msgr'],
  'org-private': ['org-private', 0, 0, 0, 0, 0, 'msgr'],
  'org-dm': ['org-dm', 0, 1, 1, 0, 1, 'msgr-dm'],
  'org-dm-memoff': ['org-dm', 0, 1, 1, 0, 1, 'msgr-dm'],
  'org-public-memoff': ['org-public', 0, 0, 0, 1, 1, 'msgr'],
  'personal-crew-dm': ['personal-crew-dm', 1, 1, 0, 0, 1, 'msgr-dm'],
  'personal-friend-dm': ['personal-friend-dm', 1, 0, 0, 0, 1, 'msgr-dm'],
  'personal-group': ['personal-group', 1, 0, 0, 0, 0, 'msgr'],
  'personal-dm-nopair': ['personal-friend-dm', 1, 0, 0, 0, 1, 'msgr-dm'],
  'dm-org-missing': ['personal-friend-dm', 1, 1, 0, 0, 1, 'msgr-dm'], // SUSPECT — 개인 방인데 DM 수신(엄격 비교). 도달 불가
  'mismatch-orgcrew-personalroom': ['personal-crew-dm', 1, 1, 0, 0, 1, 'msgr-dm'],
  'mismatch-personalcrew-orgroom': ['org-dm', 0, 1, 1, 0, 1, 'msgr-dm'],
  none: ['none', 0, 0, 0, 0, 0, null],
};

test('대화 위치 — 공간 13종의 판정 묶음이 기대값과 같고, 옮기기 전 식과 칸마다 같다', () => {
  for (const [name, { ch }] of Object.entries(SPACES)) {
    const loc = chatLocation(ch);
    const got = [loc.kind, +loc.personal, +loc.deliveryDm, +loc.relayDm, +loc.orgTopic, +loc.sessionless, ch ? contextScopeKind(ch) : null];
    assert.deepEqual(got, LOCATION_EXPECTED[name], `${name} 기대값`);
    assert.equal(loc.deliveryDm, OLD.deliveryDm(ch), `${name} deliveryDm = 옛 식`);
    assert.equal(loc.relayDm, OLD.relayChannel(ch), `${name} relayDm = 옛 식`);
    if (!ch) continue; // 채널 없음은 run이 그 전에 잡을 버린다(아래 식들이 도는 자리에 오지 않는다)
    assert.equal(loc.orgTopic, OLD.orgTopic(ch), `${name} orgTopic = 옛 식`);
    assert.equal(loc.sessionless, OLD.sessionless(ch), `${name} sessionless = 옛 식`);
    assert.equal(contextScopeKind(ch), OLD.scope(ch), `${name} 기록 표지 = 옛 식`);
    assert.equal(loc.personal, OLD.personalRoom(ch), `${name} 개인 방 = 옛 식`);
  }
  assert.ok(Object.values(LOCATION).every((k) => Object.values(LOCATION_EXPECTED).some((row) => row[0] === k)), '모든 위치 종류가 행렬에 한 칸 이상 있다');
});

// 턴 판정 기대값 — 칸 순서: 위치 종류 · 개인 턴 · 두 축 일치 · 조직 도구 · 손님 · 풀 오토 · 주인 혼자 1:1 · 결재/예약 기록(자기) · 예약 기록(동료 대상) · 방 밖 넘김 거절 문구
// 기록·넘김 칸: ok = 기록을 만든다 / guest·friend-room·unknown·other-agent·personal-room·org-peer = 그 거절 문구
// SUSPECT 메모 — org-*|guest·no-origin의 '결재/예약 기록 ok': 조직 턴은 손님이어도 기록을 만들고 guest 표지만 싣는다(실행 쪽이 손님 권한으로 돈다 — 설계상 의도로 보이나 위치 판정이 없다)
//              mismatch-orgcrew-personalroom의 '조직 도구 1': 개인 방에서 조직 오피스 도구가 실린다(봉투 경로에선 잡을 버려 도달 불가 — 옛 서버만)
const TURN_EXPECTED = {
  "org-public|owner": "org-public 0 1 1 0 1 0 ok ok org-peer",
  "org-public|owner-solo": "org-public 0 1 1 0 1 0 ok ok org-peer",
  "org-public|guest": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "org-public|guest-chain": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "org-public|handoff-own": "org-public 0 1 1 0 0 0 ok ok org-peer",
  "org-public|handoff-guest-root": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "org-public|office": "org-public 0 1 1 0 0 0 ok ok org-peer",
  "org-public|no-origin": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "org-private|owner": "org-private 0 1 1 0 1 0 ok ok org-peer",
  "org-private|owner-solo": "org-private 0 1 1 0 1 0 ok ok org-peer",
  "org-private|guest": "org-private 0 1 1 1 0 0 ok ok org-peer",
  "org-private|guest-chain": "org-private 0 1 1 1 0 0 ok ok org-peer",
  "org-private|handoff-own": "org-private 0 1 1 0 0 0 ok ok org-peer",
  "org-private|handoff-guest-root": "org-private 0 1 1 1 0 0 ok ok org-peer",
  "org-private|office": "org-private 0 1 1 0 0 0 ok ok org-peer",
  "org-private|no-origin": "org-private 0 1 1 1 0 0 ok ok org-peer",
  "org-dm|owner": "org-dm 0 1 1 0 1 0 ok ok org-peer",
  "org-dm|owner-solo": "org-dm 0 1 1 0 1 1 ok ok org-peer",
  "org-dm|guest": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-dm|guest-chain": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-dm|handoff-own": "org-dm 0 1 1 0 0 0 ok ok org-peer",
  "org-dm|handoff-guest-root": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-dm|office": "org-dm 0 1 1 0 0 0 ok ok org-peer",
  "org-dm|no-origin": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-dm-memoff|owner": "org-dm 0 1 1 0 1 0 ok ok org-peer",
  "org-dm-memoff|owner-solo": "org-dm 0 1 1 0 1 1 ok ok org-peer",
  "org-dm-memoff|guest": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-dm-memoff|guest-chain": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-dm-memoff|handoff-own": "org-dm 0 1 1 0 0 0 ok ok org-peer",
  "org-dm-memoff|handoff-guest-root": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-dm-memoff|office": "org-dm 0 1 1 0 0 0 ok ok org-peer",
  "org-dm-memoff|no-origin": "org-dm 0 1 1 1 0 0 ok ok org-peer",
  "org-public-memoff|owner": "org-public 0 1 1 0 1 0 ok ok org-peer",
  "org-public-memoff|owner-solo": "org-public 0 1 1 0 1 0 ok ok org-peer",
  "org-public-memoff|guest": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "org-public-memoff|guest-chain": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "org-public-memoff|handoff-own": "org-public 0 1 1 0 0 0 ok ok org-peer",
  "org-public-memoff|handoff-guest-root": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "org-public-memoff|office": "org-public 0 1 1 0 0 0 ok ok org-peer",
  "org-public-memoff|no-origin": "org-public 0 1 1 1 0 0 ok ok org-peer",
  "personal-crew-dm|owner": "personal-crew-dm 1 1 0 0 1 0 ok other-agent personal-room",
  "personal-crew-dm|owner-solo": "personal-crew-dm 1 1 0 0 1 1 ok other-agent personal-room",
  "personal-crew-dm|guest": "personal-crew-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-crew-dm|guest-chain": "personal-crew-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-crew-dm|handoff-own": "personal-crew-dm 1 1 0 0 0 0 ok other-agent personal-room",
  "personal-crew-dm|handoff-guest-root": "personal-crew-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-crew-dm|office": "personal-crew-dm 1 1 0 0 0 0 ok other-agent personal-room",
  "personal-crew-dm|no-origin": "personal-crew-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-friend-dm|owner": "personal-friend-dm 1 1 0 0 1 0 friend-room friend-room personal-room",
  "personal-friend-dm|owner-solo": "personal-friend-dm 1 1 0 0 1 1 friend-room friend-room personal-room",
  "personal-friend-dm|guest": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-friend-dm|guest-chain": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-friend-dm|handoff-own": "personal-friend-dm 1 1 0 0 0 0 friend-room friend-room personal-room",
  "personal-friend-dm|handoff-guest-root": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-friend-dm|office": "personal-friend-dm 1 1 0 0 0 0 friend-room friend-room personal-room",
  "personal-friend-dm|no-origin": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-group|owner": "personal-group 1 1 0 0 1 0 friend-room friend-room personal-room",
  "personal-group|owner-solo": "personal-group 1 1 0 0 1 0 friend-room friend-room personal-room",
  "personal-group|guest": "personal-group 1 1 0 1 0 0 guest guest personal-room",
  "personal-group|guest-chain": "personal-group 1 1 0 1 0 0 guest guest personal-room",
  "personal-group|handoff-own": "personal-group 1 1 0 0 0 0 friend-room friend-room personal-room",
  "personal-group|handoff-guest-root": "personal-group 1 1 0 1 0 0 guest guest personal-room",
  "personal-group|office": "personal-group 1 1 0 0 0 0 friend-room friend-room personal-room",
  "personal-group|no-origin": "personal-group 1 1 0 1 0 0 guest guest personal-room",
  "personal-dm-nopair|owner": "personal-friend-dm 1 1 0 0 1 0 friend-room friend-room personal-room",
  "personal-dm-nopair|owner-solo": "personal-friend-dm 1 1 0 0 1 1 friend-room friend-room personal-room",
  "personal-dm-nopair|guest": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-dm-nopair|guest-chain": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-dm-nopair|handoff-own": "personal-friend-dm 1 1 0 0 0 0 friend-room friend-room personal-room",
  "personal-dm-nopair|handoff-guest-root": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "personal-dm-nopair|office": "personal-friend-dm 1 1 0 0 0 0 friend-room friend-room personal-room",
  "personal-dm-nopair|no-origin": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "dm-org-missing|owner": "personal-friend-dm 1 1 0 0 1 0 unknown unknown personal-room",
  "dm-org-missing|owner-solo": "personal-friend-dm 1 1 0 0 1 1 unknown unknown personal-room",
  "dm-org-missing|guest": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "dm-org-missing|guest-chain": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "dm-org-missing|handoff-own": "personal-friend-dm 1 1 0 0 0 0 unknown unknown personal-room",
  "dm-org-missing|handoff-guest-root": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "dm-org-missing|office": "personal-friend-dm 1 1 0 0 0 0 unknown unknown personal-room",
  "dm-org-missing|no-origin": "personal-friend-dm 1 1 0 1 0 0 guest guest personal-room",
  "mismatch-orgcrew-personalroom|owner": "personal-crew-dm 0 0 1 0 1 0 ok ok org-peer",
  "mismatch-orgcrew-personalroom|owner-solo": "personal-crew-dm 0 0 1 0 1 1 ok ok org-peer",
  "mismatch-orgcrew-personalroom|guest": "personal-crew-dm 0 0 1 1 0 0 ok ok org-peer",
  "mismatch-orgcrew-personalroom|guest-chain": "personal-crew-dm 0 0 1 1 0 0 ok ok org-peer",
  "mismatch-orgcrew-personalroom|handoff-own": "personal-crew-dm 0 0 1 0 0 0 ok ok org-peer",
  "mismatch-orgcrew-personalroom|handoff-guest-root": "personal-crew-dm 0 0 1 1 0 0 ok ok org-peer",
  "mismatch-orgcrew-personalroom|office": "personal-crew-dm 0 0 1 0 0 0 ok ok org-peer",
  "mismatch-orgcrew-personalroom|no-origin": "personal-crew-dm 0 0 1 1 0 0 ok ok org-peer",
  "mismatch-personalcrew-orgroom|owner": "org-dm 0 0 0 0 1 0 unknown unknown personal-room",
  "mismatch-personalcrew-orgroom|owner-solo": "org-dm 0 0 0 0 1 1 unknown unknown personal-room",
  "mismatch-personalcrew-orgroom|guest": "org-dm 0 0 0 1 0 0 guest guest personal-room",
  "mismatch-personalcrew-orgroom|guest-chain": "org-dm 0 0 0 1 0 0 guest guest personal-room",
  "mismatch-personalcrew-orgroom|handoff-own": "org-dm 0 0 0 0 0 0 unknown unknown personal-room",
  "mismatch-personalcrew-orgroom|handoff-guest-root": "org-dm 0 0 0 1 0 0 guest guest personal-room",
  "mismatch-personalcrew-orgroom|office": "org-dm 0 0 0 0 0 0 unknown unknown personal-room",
  "mismatch-personalcrew-orgroom|no-origin": "org-dm 0 0 0 1 0 0 guest guest personal-room",
  "none|owner": "none 0 0 1 0 1 0 ok ok org-peer",
  "none|owner-solo": "none 0 0 1 0 1 0 ok ok org-peer",
  "none|guest": "none 0 0 1 1 0 0 ok ok org-peer",
  "none|guest-chain": "none 0 0 1 1 0 0 ok ok org-peer",
  "none|handoff-own": "none 0 0 1 0 0 0 ok ok org-peer",
  "none|handoff-guest-root": "none 0 0 1 1 0 0 ok ok org-peer",
  "none|office": "none 0 0 1 0 0 0 ok ok org-peer",
  "none|no-origin": "none 0 0 1 1 0 0 ok ok org-peer",
};

const refusal = (e) => {
  const m = String(e?.message ?? e);
  return /주인이 아닌 사람/.test(m) ? 'guest' : /친구와의 방/.test(m) ? 'friend-room' : /개인 공간에서는 아직/.test(m) ? 'unknown'
    : /개인 공간의 이 방/.test(m) ? 'personal-room' : /다른 에이전트/.test(m) ? 'other-agent' : /같은 메신저 조직/.test(m) ? 'org-peer' : `?${m.slice(0, 30)}`;
};
const outcome = (f) => { try { const v = f(); return v === true || (v && typeof v === 'object') ? 'ok' : String(v); } catch (e) { return refusal(e); } };
const turnCtx = (s, a) => {
  const ctx = { kind: 'msgr', orgId: s.crewOrg, channelId: 'ch', channelKind: s.ch?.kind, crewId: 'c1', uid: UID, wsId: WS, peers, handoffs: [], hop: 0, ...a };
  // 게이트웨이 run과 같은 자리 — 두 축이 모두 개인이고 손님이 아니면 서버에 묻고(ownCrewRoom), 모르면(null) 표지를 싣지 않는다
  if (OLD.personalTurn(ctx, s.ch ?? {}) && !isGuestCtx(ctx) && s.own != null) ctx.ownCrewRoom = s.own;
  return ctx;
};

test('턴 판정 — 공간 13종 × 행위자 8종 = 104칸이 기대값(옮기기 전 동작)과 같다', () => {
  let n = 0;
  for (const [sk, s] of Object.entries(SPACES)) for (const [ak, a] of Object.entries(ACTORS)) {
    const ctx = turnCtx(s, a);
    const j = judgeSpace({ channel: s.ch, ctx });
    const row = [j.location.kind, +j.personalTurn, +j.consistent, +j.work.orgTools, +isGuestCtx(ctx), +fullAutoAllowed(ctx), +ownerSoloTurn(ctx),
      outcome(() => messengerOrigin(ctx)), outcome(() => messengerOrigin(ctx, 'peer')), outcome(() => stageMessengerHandoff({ ...ctx, handoffs: [] }, { to: 'nobody', message: 'x' }))].join(' ');
    assert.equal(row, TURN_EXPECTED[`${sk}|${ak}`], `${sk} × ${ak}`);
    // 작업 문맥 축은 옮기기 전 식과도 칸마다 같다
    assert.equal(j.work.personal, OLD.personalWork(ctx), `${sk} × ${ak} 개인 작업 = 옛 식`);
    assert.equal(j.work.orgTools, OLD.orgTools(ctx), `${sk} × ${ak} 조직 도구 = 옛 식`);
    if (s.ch) assert.equal(j.personalTurn, OLD.personalTurn(ctx, s.ch), `${sk} × ${ak} 개인 턴 = 옛 식`);
    n++;
  }
  assert.equal(n, Object.keys(TURN_EXPECTED).length, '기대값 표와 칸 수가 같다(빠진 칸 없음)');
});

test('작업 문맥 — 메신저 밖 턴(데스크톱·텔레그램·위임 규칙 턴)은 조직도 개인도 아니다', () => {
  for (const ctx of [null, undefined, {}, { kind: 'msgr-rules', orgId: ORG }, { kind: 'room', orgId: ORG }]) {
    assert.deepEqual(workContext(ctx), { msgr: false, orgId: null, personal: false, orgTools: false }, JSON.stringify(ctx));
    assert.equal(workContext(ctx).orgTools, OLD.orgTools(ctx));
  }
  assert.deepEqual(workContext({ kind: 'msgr', orgId: '' }), { msgr: true, orgId: null, personal: true, orgTools: false }, '빈 문자열 조직 = 개인(옛 식 !ctx.orgId와 같다)');
});

test('이어 실행 기록 — 개인 갈래 판정은 옮기기 전 식과 같다(표지는 운반용, 실행 때 서버가 다시 판정)', () => {
  const cases = [null, {}, { orgId: null }, { orgId: null, ownCrewRoom: true }, { orgId: undefined, ownCrewRoom: true }, { ownCrewRoom: true },
    { orgId: ORG, ownCrewRoom: true }, { orgId: null, ownCrewRoom: 'true' }, { orgId: '', ownCrewRoom: true }];
  const want = [false, false, false, true, true, true, false, false, false];
  cases.forEach((o, i) => { assert.equal(personalOrigin(o), want[i], JSON.stringify(o)); assert.equal(personalOrigin(o), OLD.personalOrigin(o)); });
});
