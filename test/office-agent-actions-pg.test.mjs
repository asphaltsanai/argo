// 오피스 원격 MCP의 대기 변경(office_agent_actions, 2026-10-13 오피스 분리) — 실제 배포될 마이그레이션 그대로.
// 본인 행만·조직은 손님 아닌 구성원만·대기 중 50개 상한·잡기는 한 번만·상태 전이·직접 표 접근 막힘·30일 보존.
// 실행: bash scripts/billing-pg-drill.sh test/office-agent-actions-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'Run scripts/billing-pg-drill.sh test/office-agent-actions-pg.test.mjs';
const U = Object.fromEntries(['owner', 'member', 'guest', 'outsider'].map((k) => [k, randomUUID()]));
let ORG;
const raw = (q) => psqlSpawn(DB, ['-A', '-t', '-c', q]);
const sql = (q) => { const r = raw(q); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const as = (u, q) => `set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last = (s) => s.split('\n').filter(Boolean).at(-1);
const add = (u, { org = ORG, tool = 'office_work', action = 'task_add', args = { action: 'task_add', title: 'x' }, summary = '할 일 추가: x' } = {}) =>
  last(sql(as(u, `select office_agent_action_add(${org ? quote(org) : 'null'}, ${quote(tool)}, ${quote(action)}, ${quote(JSON.stringify(args))}::jsonb, ${quote(summary)}, 'Argo')`)));
const addRaw = (u, org) => raw(as(u, `select office_agent_action_add(${org ? quote(org) : 'null'}, 'office_work', 'task_add', '{"action":"task_add"}'::jsonb, 's', 'Argo')`));
const list = (u) => JSON.parse(last(sql(as(u, 'select office_agent_action_list()'))));

before(() => {
  if (!DB) return;
  sql(`do $$begin
 if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
 end$$;
 grant usage on schema public to anon,authenticated,service_role;
 create schema auth; grant usage on schema auth to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,created_at timestamptz default now(),email text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('argo.uid',true),'')::uuid$$;
 create schema storage;
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid);
 create table storage.buckets(id text primary key,name text,public boolean default false);
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated; grant select,insert,delete on storage.objects to authenticated;
 create schema realtime;
 create table realtime.messages(id bigint generated always as identity primary key,topic text,extension text,payload jsonb);
 create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
 create function realtime.send(payload jsonb,event text,topic text,private boolean default true) returns void language sql as $$select null::void$$;
 alter table realtime.messages enable row level security; grant select,insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql', '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql', '20260927144230_office_business.sql', '20261013020000_office_agent_actions.sql']) {
    const r = psqlSpawn(DB, ['-f', fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url))]); if (r.status !== 0) throw new Error(`${f}: ${r.stderr}`);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users(id,email) values(${quote(id)},${quote(`${k}@example.test`)})`);
  ORG = last(sql(as(U.owner, `insert into msgr_orgs(name,slug,owner_user_id) values('Acts','acts',${quote(U.owner)}) returning id`)));
  sql(`insert into msgr_org_entitlements(org_id,plan,seats) values(${quote(ORG)},'team',20) on conflict(org_id) do update set plan='team',seats=20`);
  for (const k of ['member', 'guest']) sql(`insert into msgr_org_members(org_id,user_id,role) values(${quote(ORG)},${quote(U[k])},${quote(k)}) on conflict do nothing`);
});

test('추가 — 본인 행, 조직 구성원만(손님·바깥 사람 거절), 개인 공간(조직 없음)도 된다', { skip }, () => {
  const id = add(U.member);
  assert.match(id, /^[0-9a-f-]{36}$/);
  const mine = list(U.member);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'pending'); assert.equal(mine[0].org_id, ORG); assert.equal(mine[0].source, 'Argo');
  assert.equal(mine[0].user_id, undefined, '목록에 user_id는 내지 않는다');
  assert.equal(list(U.owner).length, 0, '남의 행은 보이지 않는다');
  assert.notEqual(addRaw(U.guest, ORG).status, 0, '손님 거절');
  assert.notEqual(addRaw(U.outsider, ORG).status, 0, '조직 밖 거절');
  assert.match(add(U.outsider, { org: null, tool: 'calendar', action: 'create', args: { action: 'create' }, summary: '일정 만들기' }), /^[0-9a-f-]{36}$/, '개인 공간');
});

test('모양 검사 — 모르는 도구·이상한 동작·배열 인자·빈 요약 거절', { skip }, () => {
  for (const q of [
    `select office_agent_action_add(null,'Bash','run','{}'::jsonb,'s','x')`,
    `select office_agent_action_add(null,'office_work','DROP TABLE','{}'::jsonb,'s','x')`,
    `select office_agent_action_add(null,'office_work','task_add','[]'::jsonb,'s','x')`,
    `select office_agent_action_add(null,'office_work','task_add','{}'::jsonb,'  ','x')`,
  ]) assert.notEqual(raw(as(U.outsider, q)).status, 0, q);
});

test('직접 표 접근은 막힌다 — 함수로만', { skip }, () => {
  assert.notEqual(raw(as(U.member, 'select * from office_agent_actions')).status, 0);
  assert.notEqual(raw(as(U.member, `update office_agent_actions set status='done'`)).status, 0);
  assert.notEqual(raw('set role anon; select office_agent_action_list()').status, 0, 'anon은 함수도 못 부른다');
  assert.notEqual(raw(as(U.member, 'select office_agent_action_sweep()')).status, 0, '보존 정리는 사용자가 못 부른다');
});

test('잡기·결과 — 대기 중인 내 행만, 두 번 잡히지 않는다, 남의 행은 못 잡는다', { skip }, () => {
  const id = add(U.owner);
  assert.equal(last(sql(as(U.member, `select office_agent_action_claim(${quote(id)})`))) ?? '', '', '남의 행은 null');
  const row = JSON.parse(last(sql(as(U.owner, `select office_agent_action_claim(${quote(id)})`))));
  assert.equal(row.status, 'running'); assert.equal(row.tool, 'office_work'); assert.deepEqual(row.args, { action: 'task_add', title: 'x' });
  assert.equal(last(sql(as(U.owner, `select office_agent_action_claim(${quote(id)})`))) ?? '', '', '두 번째 잡기는 null');
  assert.equal(last(sql(as(U.owner, `select office_agent_action_cancel(${quote(id)})`))), 'f', '실행 중은 취소 못 한다');
  assert.equal(last(sql(as(U.member, `select office_agent_action_finish(${quote(id)}, true, 'x')`))), 'f', '남의 행 결과는 못 쓴다');
  assert.equal(last(sql(as(U.owner, `select office_agent_action_finish(${quote(id)}, true, '만들었다')`))), 't');
  const done = list(U.owner).find((a) => a.id === id);
  assert.equal(done.status, 'done'); assert.equal(done.result, '만들었다');
  assert.equal(last(sql(as(U.owner, `select office_agent_action_finish(${quote(id)}, false, 'again')`))), 'f', '끝난 행은 다시 안 바뀐다');
});

test('취소 — 대기 중인 내 행만', { skip }, () => {
  const id = add(U.owner);
  assert.equal(last(sql(as(U.member, `select office_agent_action_cancel(${quote(id)})`))), 'f');
  assert.equal(last(sql(as(U.owner, `select office_agent_action_cancel(${quote(id)})`))), 't');
  assert.equal(list(U.owner).find((a) => a.id === id).status, 'canceled');
  assert.equal(last(sql(as(U.owner, `select office_agent_action_claim(${quote(id)})`))) ?? '', '', '취소한 행은 실행 못 한다');
});

test('대기 중 50개 상한 — 넘으면 거절, 처리하면 다시 올린다', { skip }, () => {
  const u = U.outsider;
  const have = list(u).filter((a) => a.status === 'pending').length;
  for (let i = have; i < 50; i++) add(u, { org: null, tool: 'calendar', action: 'create', args: { action: 'create' }, summary: `일정 ${i}` });
  const over = raw(as(u, `select office_agent_action_add(null,'calendar','create','{"action":"create"}'::jsonb,'over','x')`));
  assert.notEqual(over.status, 0); assert.match(over.stderr, /agent_action_limit/);
  const one = list(u).find((a) => a.status === 'pending');
  sql(as(u, `select office_agent_action_cancel(${quote(one.id)})`));
  assert.match(add(u, { org: null, tool: 'calendar', action: 'create', args: { action: 'create' }, summary: 'after' }), /^[0-9a-f-]{36}$/);
});

test('보존 30일 — 30일 지난 행만 지운다', { skip }, () => {
  const old = add(U.member), fresh = add(U.member);
  sql(`update office_agent_actions set created_at = now() - interval '31 days' where id = ${quote(old)}`);
  sql(`update office_agent_actions set created_at = now() - interval '29 days' where id = ${quote(fresh)}`);
  assert.ok(Number(sql('select office_agent_action_sweep()')) >= 1);
  const ids = list(U.member).map((a) => a.id);
  assert.ok(!ids.includes(old)); assert.ok(ids.includes(fresh));
});
