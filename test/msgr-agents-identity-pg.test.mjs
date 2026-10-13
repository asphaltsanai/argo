// 기억·공간 3단계 U1 "정체 층"(*_msgr_agents_identity.sql, 설계 artifacts/space-stage3/design.md E1·E2) — 실제 Postgres에서 잰다.
//  에이전트 1명 = msgr_agents 1행(주인·회사·slug). msgr_crews 행은 그 에이전트의 공간 자리 — agent_id로 묶는다. 행·FK 자식은 지우거나 옮기지 않는다.
//  잠그는 것: 한 번 채우기(운영 모양 — 같은 에이전트 1~4자리·외부 봇 쌍둥이·정책 잠금과 어긋난 행)·멱등(쓰기 0)·새 자리 트리거(옛 앱·옛 게이트웨이 경로)·
//  클라이언트가 보낸 agent_id 무시·fail-open·주기 쓰기 0(심박·게이트웨이 upsert 반복)·RLS(주인·조직 멤버만 읽기, 쓰기 없음)·계정 삭제·조직 삭제·
//  채널 기억이 자리 범위 그대로(X2)·되돌리기(drop) 뒤 기존 동작과 다시 적용.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-agents-identity-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-agents-identity-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// 이름 끝으로 찾는다 — 적용 직전에 버전만 다시 매겨도 이 시험은 그대로 돈다
const FIX = readdirSync(mig('')).filter((f) => f.endsWith('_msgr_agents_identity.sql')).sort().pop();
assert.ok(FIX, 'supabase/migrations/*_msgr_agents_identity.sql 이 있어야 한다');
const U = {
  a: '11111111-1111-4111-8111-111111111111', // 조직 1·2 owner — 에이전트 여럿
  b: '22222222-2222-4222-8222-222222222222', // 조직 1 member
  c: '33333333-3333-4333-8333-333333333333', // 조직 1 member — 개인 자리만 있는 에이전트
  d: '44444444-4444-4444-8444-444444444444', // 어느 조직에도 없음
  e: '55555555-5555-4555-8555-555555555555', // 조직 1 member — 계정 삭제
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰 전용
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asUser = (uid, q) => { const r = asUserRaw(uid, q); if (r.status !== 0) throw new Error(`psql 실패(${uid.slice(0, 2)}): ${r.stderr}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const applyMig = (f) => psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
const ROLLBACK = `
  drop trigger if exists msgr_crews_zz_agent_link on public.msgr_crews;
  drop trigger if exists msgr_crews_zz_agent_keep on public.msgr_crews;
  drop function if exists public.msgr_crews_agent_link(); drop function if exists public.msgr_agents_backfill();
  drop policy if exists msgr_agents_select on public.msgr_agents;
  alter table public.msgr_crews drop column if exists agent_id;
  drop table if exists public.msgr_agents;`;

let ORG1, ORG2; const C = {}; // 자리 이름 → id
const crew = (name, org, owner, ws, slug, { hosting = 'local', status = 'active', allow } = {}) => {
  const pre = hosting === 'bot' ? `select set_config('msgr.bot_create', '1', false); ` : '';
  const al = allow ?? (org ? 'all' : 'owner');
  C[name] = last(sql(`${pre}insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow)
    values (${org ? `'${org}'` : 'null'}, '${owner}', '${ws}', '${slug}', '${slug}', '${hosting}', '${status}', '${al}') returning id`));
  return C[name];
};
const agentOf = (name) => sql(`select coalesce(agent_id::text, 'null') from public.msgr_crews where id = '${C[name]}'`);
const agentFor = (owner, ws, slug) => sql(`select id from public.msgr_agents where owner_user_id = '${owner}' and ws_id = '${ws}' and slug = '${slug}'`);
const nAgents = () => Number(sql('select count(*) from public.msgr_agents'));
const triples = () => Number(sql('select count(*) from (select distinct owner_user_id, ws_id, slug from public.msgr_crews) s'));
const xmins = (t) => sql(`select string_agg(id::text || ':' || xmin::text, ',' order by id) from public.${t}`);
const has = (q) => sql(`select exists (${q})`) === 't';

before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const files = readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort();
  for (const f of files.filter((x) => x < FIX)) applyMig(f); // 이 파일 직전까지 — 운영(마이그레이션 전) 모양에서 시작
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG1 = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  ORG2 = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Side', 'side', '${U.a}') returning id`));
  for (const o of [ORG1, ORG2]) sql(`update public.msgr_org_entitlements set plan = 'team', seats = 20 where org_id = '${o}'`);
  for (const u of [U.b, U.c, U.e]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG1}', 'member', '${U.a}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG1);
  }
  // 운영 모양의 자리(마이그레이션 전 — agent_id 열 없음)
  crew('pepper1', ORG1, U.a, 'ws-a', 'pepper'); crew('pepper2', ORG2, U.a, 'ws-a', 'pepper'); crew('pepperP', null, U.a, 'ws-a', 'pepper'); // 한 에이전트 3자리
  crew('max1', ORG1, U.a, 'ws-a', 'max'); // 조직 자리만
  crew('yoda1', ORG1, U.a, 'ws-a', 'yoda'); crew('yodaOther', null, U.a, 'ws-other', 'yoda'); // 회사가 다르면 다른 에이전트
  crew('bot1', ORG1, U.a, 'bot', 'bot-xyz', { hosting: 'bot' }); crew('botP', null, U.a, 'bot', 'bot-xyz', { hosting: 'bot' }); // 외부 봇 + 개인 쌍둥이(G6 — 한 에이전트의 두 자리)
  crew('shuri1', ORG1, U.b, 'ws-b', 'shuri'); crew('shuriP', null, U.b, 'ws-b', 'shuri', { status: 'paused' }); // 무료 일시 정지 자리
  crew('bPepper', null, U.b, 'ws-a', 'pepper'); // 남이 같은 회사·slug를 가져도 주인이 다르면 다른 에이전트
  crew('cSolo', null, U.c, 'ws-c', 'solo'); // 개인 자리만 — 주인만 본다
  crew('eAgent1', ORG1, U.e, 'ws-e', 'eva'); crew('eAgentP', null, U.e, 'ws-e', 'eva');
  crew('drift', ORG1, U.a, 'ws-a', 'drift', { allow: 'owner' }); // 정책 잠금 전에 만든, 기본값과 다른 allow
  crew('detached', ORG1, U.a, 'ws-a', 'gone', { status: 'detached' });
  sql(`insert into public.msgr_org_policies (org_id, allow_default, allow_locked) values ('${ORG1}', 'all', true) on conflict (org_id) do update set allow_default = 'all', allow_locked = true`);
  // 정책을 잠그면 msgr_policy_after_update가 조직 자리의 allow를 기본값으로 맞추므로 어긋난 행은 보통 없다(운영 2026-10-14 0행).
  // 그래도 생기면(손 편집·옛 정의) 그 행의 어떤 update도 막힌다 — 채우기가 이 트리거에 걸리면 안 되는 이유. 그 모양을 직접 만든다.
  sql(`alter table public.msgr_crews disable trigger msgr_crew_policy_gate; update public.msgr_crews set allow = 'owner' where id = '${C.drift}'; alter table public.msgr_crews enable trigger msgr_crew_policy_gate`);
  assert.match(psqlRaw(['-c', `update public.msgr_crews set last_seen_at = now() where id = '${C.drift}'`]).stderr, /msgr_policy_locked/);
  applyMig(FIX);
});

test('채우기 — 에이전트 수 = (주인·회사·slug) 묶음 수, 모든 자리가 자기 묶음의 에이전트에 붙는다(정책 잠금 어긋난 행 포함)', { skip }, () => {
  assert.equal(nAgents(), triples());
  assert.equal(nAgents(), 11);
  assert.equal(sql('select count(*) from public.msgr_crews where agent_id is null'), '0');
  assert.equal(sql(`select count(*) from public.msgr_crews c join public.msgr_agents a on a.id = c.agent_id
    where (a.owner_user_id, a.ws_id, a.slug) is distinct from (c.owner_user_id, c.ws_id, c.slug)`), '0');
  const p = agentOf('pepper1'); assert.equal(agentOf('pepper2'), p); assert.equal(agentOf('pepperP'), p);
  assert.equal(agentOf('botP'), agentOf('bot1'));
  assert.notEqual(agentOf('yodaOther'), agentOf('yoda1'));
  assert.notEqual(agentOf('bPepper'), p);
  assert.notEqual(agentOf('drift'), 'null');
  // 정책 잠금 트리거는 채우기 뒤 다시 켜져 있다
  assert.equal(sql(`select tgenabled from pg_trigger where tgname = 'msgr_crew_policy_gate'`), 'O');
  assert.match(psqlRaw(['-c', `update public.msgr_crews set last_seen_at = now() where id = '${C.drift}'`]).stderr, /msgr_policy_locked/);
});

test('멱등 — 다시 돌리면 0행, 두 표의 행이 하나도 다시 쓰이지 않는다(xmin 불변)', { skip }, () => {
  const before1 = xmins('msgr_agents'); const before2 = xmins('msgr_crews');
  assert.equal(sql('select public.msgr_agents_backfill()'), '0');
  assert.equal(xmins('msgr_agents'), before1); assert.equal(xmins('msgr_crews'), before2);
  // 채우기 함수는 사용자·익명이 부를 수 없다
  assert.match(asUserRaw(U.a, 'select public.msgr_agents_backfill()').stderr, /permission denied/);
});

test('주기 쓰기 0 — 심박(last_seen)·게이트웨이 upsert 반복·상태 무변경 갱신은 msgr_agents를 쓰지 않고 agent_id도 그대로', { skip }, () => {
  const agents = xmins('msgr_agents'); const p = agentOf('pepper1');
  for (let i = 0; i < 3; i++) {
    sql(`update public.msgr_crews set last_seen_at = now() where id in ('${C.pepper1}', '${C.pepperP}', '${C.bot1}')`);
    // 본체 미러(mirrorInventory)와 같은 모양 — 유니크 4열 upsert
    sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow)
         values ('${ORG2}', '${U.a}', 'ws-a', 'pepper', 'pepper', 'local', 'active', 'all')
         on conflict (org_id, owner_user_id, ws_id, slug) do update set display_name = excluded.display_name`);
  }
  assert.equal(xmins('msgr_agents'), agents);
  assert.equal(agentOf('pepper1'), p); assert.equal(agentOf('pepper2'), p);
  // 심박 갱신에는 agent 트리거 함수가 불리지 않는다(WHEN 절) — 트리거 정의로 확인
  assert.match(sql(`select pg_get_triggerdef(oid) from pg_trigger where tgname = 'msgr_crews_zz_agent_keep'`), /WHEN \(\(old\.agent_id IS DISTINCT FROM new\.agent_id\)\)/);
});

test('새 자리 트리거 — 옛 앱 경로(사용자 insert)로 기존 에이전트에 새 조직 자리: 에이전트 수 불변, 같은 agent', { skip }, () => {
  const n = nAgents();
  const id = last(asUser(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow)
    values (null, '${U.b}', 'ws-b', 'shuri2', 'shuri2', 'local', 'active', 'owner') returning id`));
  assert.equal(nAgents(), n + 1, '새 에이전트는 첫 자리에서 1행');
  const a = sql(`select agent_id from public.msgr_crews where id = '${id}'`);
  assert.equal(a, agentFor(U.b, 'ws-b', 'shuri2'));
  // 같은 에이전트의 두 번째 자리(조직) — 정책이 잠긴 조직이라 allow는 정책 기본값으로 바뀌어 들어간다(지금 동작)
  const id2 = last(asUser(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow)
    values ('${ORG1}', '${U.b}', 'ws-b', 'shuri2', 'shuri2', 'local', 'active', 'owner') returning id`));
  assert.equal(nAgents(), n + 1);
  assert.equal(sql(`select agent_id from public.msgr_crews where id = '${id2}'`), a);
  assert.equal(sql(`select allow from public.msgr_crews where id = '${id2}'`), 'all');
});

test('클라이언트가 보낸 agent_id는 믿지 않는다 — insert·update 모두 (주인·회사·slug)의 에이전트로 다시 정한다', { skip }, () => {
  const others = agentOf('pepper1'); // a의 에이전트
  const id = last(asUser(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow, agent_id)
    values (null, '${U.b}', 'ws-b', 'sneak', 'sneak', 'local', 'active', 'owner', '${others}') returning id`));
  const mine = agentFor(U.b, 'ws-b', 'sneak');
  assert.equal(sql(`select agent_id from public.msgr_crews where id = '${id}'`), mine);
  asUser(U.b, `update public.msgr_crews set agent_id = '${others}' where id = '${id}'`);
  assert.equal(sql(`select agent_id from public.msgr_crews where id = '${id}'`), mine);
  asUser(U.b, `update public.msgr_crews set agent_id = null where id = '${id}'`);
  assert.equal(sql(`select agent_id from public.msgr_crews where id = '${id}'`), mine);
});

test('fail-open — 에이전트를 만들 수 없어도 자리 insert는 통과하고 agent_id만 비며, 다시 채우기로 붙는다', { skip }, () => {
  sql(`alter table public.msgr_agents add constraint t_block check (slug <> 'blocked')`);
  try {
    const r = psqlRaw(['-A', '-t', '-c', `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow)
      values (null, '${U.c}', 'ws-c', 'blocked', 'blocked', 'local', 'active', 'owner') returning id`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /msgr_crews_agent_link/);
    C.blocked = last(r.stdout.trim());
    assert.equal(agentOf('blocked'), 'null');
  } finally { sql('alter table public.msgr_agents drop constraint t_block'); }
  assert.equal(sql('select public.msgr_agents_backfill()'), '1');
  assert.equal(agentOf('blocked'), agentFor(U.c, 'ws-c', 'blocked'));
});

test('RLS — 주인은 자기 에이전트 전부, 조직 멤버는 조직 자리가 있는 에이전트만, 밖의 사람은 없음. 사용자 쓰기는 없다', { skip }, () => {
  const sees = (uid, name) => asUser(uid, `select count(*) from public.msgr_agents where id = '${agentOf(name)}'`) === '1';
  assert.ok(sees(U.a, 'pepper1')); assert.ok(sees(U.a, 'yodaOther')); // 주인 — 개인 자리만인 것도
  assert.ok(sees(U.b, 'pepper1'), '조직 1 멤버 — a의 페퍼는 조직 1 자리가 있다');
  assert.ok(!sees(U.b, 'yodaOther'), 'a의 개인 자리만 있는 에이전트는 주인만');
  assert.ok(!sees(U.a, 'cSolo'), 'c의 개인 에이전트는 조직 owner도 못 본다');
  assert.ok(sees(U.c, 'cSolo'));
  assert.ok(sees(U.b, 'bot1'), '외부 봇은 조직 자리로 보인다');
  assert.equal(asUser(U.d, 'select count(*) from public.msgr_agents'), '0');
  assert.equal(asUserRaw(U.a, 'select count(*) from public.msgr_agents').status, 0);
  for (const q of [
    `insert into public.msgr_agents (owner_user_id, ws_id, slug) values ('${U.a}', 'ws-a', 'new')`,
    `update public.msgr_agents set slug = 'x' where owner_user_id = '${U.a}'`,
    `delete from public.msgr_agents where owner_user_id = '${U.a}'`,
  ]) assert.match(asUserRaw(U.a, q).stderr, /permission denied/, q);
  assert.match(psqlRaw(['-c', `set role anon; select count(*) from public.msgr_agents`]).stderr, /permission denied/);
  // 자리 표(msgr_crews) 가시성은 그대로 — 남의 개인 자리는 여전히 안 보인다
  assert.equal(asUser(U.b, `select count(*) from public.msgr_crews where id = '${C.yodaOther}'`), '0');
});

test('X2 — 채널 기억(msgr_crew_memory)은 자리 범위 그대로: 같은 에이전트의 다른 조직 자리 문서가 섞이지 않는다', { skip }, () => {
  sql(`insert into public.msgr_org_docs (org_id, path, title, body, created_by, updated_by) values
       ('${ORG1}', 'projects/one.md', 'one', 'ORG1-DOC', '${U.a}', '${U.a}'), ('${ORG2}', 'projects/two.md', 'two', 'ORG2-DOC', '${U.a}', '${U.a}')`);
  const m1 = asUser(U.a, `select public.msgr_crew_memory('${C.pepper1}', null)::text`);
  const m2 = asUser(U.a, `select public.msgr_crew_memory('${C.pepper2}', null)::text`);
  assert.match(m1, /ORG1-DOC/); assert.doesNotMatch(m1, /ORG2-DOC/);
  assert.match(m2, /ORG2-DOC/); assert.doesNotMatch(m2, /ORG1-DOC/);
  assert.equal(agentOf('pepper1'), agentOf('pepper2'), '같은 에이전트인데도');
});

test('무료 플랜 계산(A4) — agent_id로 센 수와 지금 (회사·slug)로 센 수가 주인마다 같다', { skip }, () => {
  assert.equal(sql(`select count(*) from (
      select owner_user_id, count(distinct agent_id) x, count(distinct (ws_id, slug)) y from public.msgr_crews where status in ('active', 'paused') group by owner_user_id) s
    where x <> y`), '0');
});

test('조직 삭제 — 그 조직 자리만 캐스케이드로 사라지고 에이전트·다른 자리는 남는다', { skip }, () => {
  const p = agentOf('pepper1');
  sql(`delete from public.msgr_orgs where id = '${ORG2}'`);
  assert.equal(sql(`select count(*) from public.msgr_crews where id = '${C.pepper2}'`), '0');
  assert.equal(agentOf('pepper1'), p);
  assert.ok(has(`select 1 from public.msgr_agents where id = '${p}'`));
});

test('계정 삭제(msgr_delete_me) — 자리와 에이전트가 함께 사라지고 FK가 막지 않는다', { skip }, () => {
  const a = agentOf('eAgent1');
  const r = asUserRaw(U.e, 'select public.msgr_delete_me()');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!has(`select 1 from auth.users where id = '${U.e}'`));
  assert.ok(!has(`select 1 from public.msgr_agents where id = '${a}'`));
  assert.ok(!has(`select 1 from public.msgr_crews where owner_user_id = '${U.e}'`));
});

test('되돌리기 — drop 뒤 기존 동작(자리 insert·upsert·심박·상태 변경) 그대로, 다시 적용하면 같은 결과로 채운다', { skip }, () => {
  const groups = triples();
  psql(['-c', ROLLBACK]);
  assert.ok(!has(`select 1 from information_schema.columns where table_name = 'msgr_crews' and column_name = 'agent_id'`));
  assert.equal(sql('select to_regclass(\'public.msgr_agents\') is null'), 't');
  const id = last(asUser(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow)
    values (null, '${U.b}', 'ws-b', 'after', 'after', 'local', 'active', 'owner') returning id`));
  assert.ok(id);
  sql(`update public.msgr_crews set last_seen_at = now() where id = '${C.pepper1}'`);
  asUser(U.a, `update public.msgr_crews set status = 'available' where id = '${C.max1}'`);
  assert.equal(sql(`select status from public.msgr_crews where id = '${C.max1}'`), 'available');
  applyMig(FIX); // 다시 앞으로
  assert.equal(nAgents(), groups + 1);
  assert.equal(sql('select count(*) from public.msgr_crews where agent_id is null'), '0');
});
