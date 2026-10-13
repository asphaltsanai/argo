// 최소 앱 버전 서버 함수(20261013180000_msgr_app_min_version) — 실제 Postgres에서 본다.
// ① 행이 없으면 null(아무 기기도 막지 않는다) ② msgr_settings 한 줄로 켜고 끈다 ③ 본체·메신저 키가 따로다
// ④ 정해진 키만 돌려준다 — 같은 표의 비밀값 행(push_secret 등)은 어떤 인자로도 나오지 않는다 ⑤ 로그인 전(anon)·사용자 모두 부를 수 있고, 표 직접 읽기는 막혀 있다
// 실행: bash scripts/billing-pg-drill.sh test/msgr-app-min-version-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-app-min-version-pg.test.mjs';
const mig = (f) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url)), 'utf8');
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const as = (role, q) => sql(`set role ${role}; ${q}`);
const asRaw = (role, q) => psqlRaw(['-A', '-t', '-c', `set role ${role}; ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const min = (role, app) => last(as(role, `select coalesce(public.argo_min_app_version(${app === undefined ? '' : `'${app}'`}), '(null)')`));

before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
  `]);
  // msgr_settings 표 정의는 20260912150000_msgr_push.sql과 같다(RLS 켬, 정책 없음) — 그 파일 전체는 다른 msgr 표에 기대므로 표만 만든다
  psql(['-c', `create table if not exists public.msgr_settings (key text primary key, value text not null); alter table public.msgr_settings enable row level security;
    insert into public.msgr_settings (key, value) values ('push_secret', 'secret-should-not-leak'), ('push_url', 'https://example.test/push') on conflict do nothing;`]);
  psql(['-c', mig('20261013180000_msgr_app_min_version.sql')]);
});

test('행이 없으면 null — 아무 기기도 막지 않는다', { skip }, () => {
  assert.equal(min('authenticated', 'desktop'), '(null)');
  assert.equal(min('authenticated'), '(null)', '인자 없음 = 본체');
  assert.equal(min('anon', 'desktop'), '(null)', '로그인 전에도 부를 수 있다');
});

test('msgr_settings 한 줄로 켜고 끈다 — 본체·메신저 키는 따로', { skip }, () => {
  sql(`insert into public.msgr_settings (key, value) values ('min_app_version', '0.1.107') on conflict (key) do update set value = excluded.value`);
  assert.equal(min('authenticated', 'desktop'), '0.1.107');
  assert.equal(min('anon', 'desktop'), '0.1.107');
  assert.equal(min('authenticated', 'messenger'), '(null)', '메신저 키는 따로');
  sql(`insert into public.msgr_settings (key, value) values ('min_app_version_messenger', '0.1.60') on conflict (key) do update set value = excluded.value`);
  assert.equal(min('authenticated', 'messenger'), '0.1.60');
  sql(`delete from public.msgr_settings where key in ('min_app_version', 'min_app_version_messenger')`);
  assert.equal(min('authenticated', 'desktop'), '(null)', '끄기');
});

test('정해진 키만 — 같은 표의 비밀값 행은 어떤 인자로도 나오지 않고, 표 직접 읽기는 막혀 있다', { skip }, () => {
  for (const app of ['push_secret', 'push_url', 'min_app_version', '', "desktop' or '1'='1"]) {
    const r = asRaw('authenticated', `select coalesce(public.argo_min_app_version($q$${app}$q$), '(null)')`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(last(r.stdout), '(null)', `인자 ${JSON.stringify(app)}`);
  }
  for (const role of ['authenticated', 'anon']) {
    const direct = asRaw(role, `select value from public.msgr_settings where key = 'push_secret'`);
    assert.ok(direct.status !== 0 || last(direct.stdout) === '', `${role}이 표를 직접 읽지 못한다`);
  }
});
