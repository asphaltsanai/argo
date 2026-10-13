// 2026-10-13 오피스 완전 분리 — 능동 비서(src/assistant: 오피스 일정·메일 감시)를 지우며 남긴 것을 잠근다.
//  ① 방 문맥 표지 줄(outsideContextLine — inbound-marks.mjs로 옮김): 방에 남은 옛 비서 메일 글은 다음 턴 문맥에 본문 대신 표지 줄로만. 오피스 커넥터 안내는 싣지 않는다.
//  ② 개인 공간 1:1 알림(personal-notice.mjs — 목표 하트비트가 쓴다): 행 모양·client_msg_id 접두·알림 종류 끄기 판정이 옛 비서와 같다.
//  ③ 사용자 데이터에 남은 옛 비서 파일(assistant.json·.assistant/state.json·mail.json)은 지우지 않고, 앱은 오류 없이 무시한다(동기화도 올리지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-personal-notice-'));
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[k];
const { outsideContextLine } = await import('../src/inbound-marks.mjs');
const N = await import('../src/personal-notice.mjs');

test('① 표지 줄 — 에이전트가 쓴 바깥 글(meta.assistant.outside)만 표지로, 사람 글·표지 없는 글은 본문 그대로, 오피스 커넥터 안내 없음', () => {
  assert.equal(outsideContextLine({ author_kind: 'user', meta: { assistant: { outside: true } }, body: 'x' }), null, '사람 글은 표지를 흉내 내도 본문 그대로');
  assert.equal(outsideContextLine({ author_kind: 'crew', meta: { assistant: { kind: 'pre' } } }), null, '표지 없는 글(일정)은 본문 그대로');
  const ko = outsideContextLine({ author_kind: 'crew', assistant: { kind: 'mail_reply', outside: true, ref: ['11111111-1111-4111-8111-111111111111.m2'] } }, 'ko');
  assert.equal(ko, '[하트비트 알림 · 답장이 필요한 메일 · 메일에서 나온 글이라 문맥에서 뺐어요]', 'contextOf 별칭(assistant:meta->assistant)도 — 메일 id·읽는 법은 싣지 않는다');
  assert.equal(outsideContextLine({ author_kind: 'crew', meta: { assistant: { kind: 'mail_batch', count: 2, outside: true } } }, 'en'), '[Heartbeat notice · 2 mails to check · left out of context because it came from mail]');
  assert.match(outsideContextLine({ author_kind: 'crew', meta: { assistant: { kind: 'sum', outside: true } } }, 'ko'), /메일 정리/);
  for (const s of [ko, outsideContextLine({ author_kind: 'crew', meta: { assistant: { outside: true } } }, 'en')]) assert.doesNotMatch(s, /오피스|office|connector|커넥터/i);
});

test('② 글 넣기 — 개인 1:1 방에 as: 접두 client_msg_id·notification assistant 표지로 한 번만(같은 기준은 dup)', async () => {
  const rows = [];
  const c = { db: { async insertMessage(row) { if (rows.some((r) => r.client_msg_id === row.client_msg_id)) return null; rows.push(row); return { id: rows.length }; } } };
  const room = { crewId: 'crew-1', channelId: 'dm-1' };
  assert.equal(await N.insertNotice(c, room, { basis: 'goal:g1:1', body: '[하트비트] 목표', meta: { kind: 'goal' } }), 'sent');
  assert.equal(await N.insertNotice(c, room, { basis: 'goal:g1:1', body: '[하트비트] 목표', meta: { kind: 'goal' } }), 'dup');
  assert.equal(rows.length, 1);
  assert.match(rows[0].client_msg_id, /^as:crew-1:[0-9a-f]{32}$/);
  assert.deepEqual(rows[0].meta, { disposition: 'done', notification: 'assistant', assistant: { kind: 'goal' } });
  assert.equal(rows[0].body.length <= N.MSG_MAX, true);
});

test('② 방 찾기 — 개인 행이 없으면 personal_room_unavailable(조직 1:1로 물러나지 않는다), 있으면 msgr_dm_personal_crew 방', async () => {
  const c = (rows, rpc) => ({ uid: 'u', db: { myCrews: async () => rows }, client: { rpc: async () => rpc } });
  await assert.rejects(N.personalRoom(c([{ org_id: 'org-1', slug: 's', id: 'x' }], { data: 'room' }), 'ws', 's'), { code: 'personal_room_unavailable' });
  await assert.rejects(N.personalRoom(c([{ org_id: null, slug: 's', id: 'p' }], { data: null, error: { message: 'boom' } }), 'ws', 's'), { code: 'personal_room_unavailable' });
  assert.deepEqual(await N.personalRoom(c([{ org_id: null, slug: 's', id: 'p' }], { data: 'room-p' }), 'ws', 's'), { crewId: 'p', channelId: 'room-p' });
});

test('② 알림 종류 끄기 — 회사 msgr.mutedEvents에 assistant가 있으면 보내지 않는다', () => {
  assert.equal(N.heartbeatMuted({ msgr: { mutedEvents: ['assistant'] } }), true);
  assert.equal(N.heartbeatMuted({ msgr: { mutedEvents: [] } }), false);
  assert.equal(N.heartbeatMuted({}), false);
});

test('③ 옛 비서 파일이 남은 회사 — 지우지 않고, 상태 읽기·동기화 판정이 오류 없이 무시한다(.assistant/는 계속 올리지 않음)', async () => {
  const { createCompany, paths } = await import('../src/workspace.mjs');
  const ws = 'legacy-assistant';
  await createCompany(ws, '옛 비서', '유건', 'owner-1');
  const root = paths(ws).root;
  const cfg = { enabled: true, agent: 'pepper', watch: { calendar: true, mail: true }, intervalMinutes: 15 };
  await writeFile(join(root, 'assistant.json'), JSON.stringify(cfg));
  await mkdir(join(root, '.assistant'), { recursive: true });
  await writeFile(join(root, '.assistant', 'state.json'), JSON.stringify({ v: 1, sent: { 'cal:e1': 1 } }));
  await writeFile(join(root, '.assistant', 'mail.json'), JSON.stringify({ v: 1, seen: { 'subject': 'x' } }));
  const company = JSON.parse(await readFile(join(root, 'company.json'), 'utf8'));
  await writeFile(join(root, 'company.json'), JSON.stringify({ ...company, assistantSeal: 'deadbeef' })); // 옛 봉인 칸
  const self = await import('../src/argo-self.mjs');
  const text = await self.argoStatus(ws, { section: 'overview', full: true, slug: null });
  assert.equal(typeof text, 'string');
  assert.doesNotMatch(text, /하트비트 켜짐|마지막 일정 확인|assistant\.json/, '옛 설정을 읽어 비서 상태를 말하지 않는다');
  assert.ok(!self.STATUS_SECTIONS.includes('assistant'));
  const { EXCLUDE } = await import('../src/sync.mjs');
  for (const rel of ['.assistant/state.json', '.assistant/mail.json', '.assistant/self-posts.json']) assert.equal(EXCLUDE(rel), true, `${rel} — 메일 메타가 든 기기 로컬 파일은 올리지 않는다`);
  for (const f of ['assistant.json', '.assistant/state.json', '.assistant/mail.json']) assert.ok(existsSync(join(root, f)), `${f} — 지우지 않는다`);
  assert.equal((await import('../src/help/topics.mjs')).TOPICS.some((t) => t.id === 'assistant' || t.id === 'heartbeat-mail'), false, '지운 기능의 도움말 없음');
});
