-- 오피스 원격 MCP의 "대기 중인 변경"(2026-10-13, 오피스 독립 앱 분리 — 유건 지시, 총괄 결정 "승인은 오피스 화면 한 곳, 보존 30일").
-- 에이전트(Argo·Claude Code·Codex 등)가 오피스 MCP(apps/office/api/mcp.js)로 쓰기 도구를 부르면 바로 실행하지 않고 여기에 한 줄을 남긴다.
-- 사람이 오피스 화면에서 [실행]을 누르면 오피스 서버(apps/office/api/agent-actions.js)가 그 사람의 세션으로 한 번 실행하고 결과를 적는다.
-- 행은 만든 사람(user_id = auth.uid())만 읽고 바꾼다. 실행 권한 자체는 실행 때 각 office_* 함수가 다시 판정한다(여기는 대기열일 뿐).
-- 부하: 쓰기 도구 호출 1회 = 행 1개 추가. 목록은 화면을 열 때·에이전트 답이 올 때만 읽는다(주기 호출 없음). 보존: 만든 지 30일 지난 행은 매일 한 번 지운다.

create table if not exists public.office_agent_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid references public.msgr_orgs(id) on delete cascade,
  tool text not null check (tool in ('calendar', 'office', 'office_files', 'office_work', 'office_deals', 'office_mail', 'office_briefing')),
  action text not null check (action ~ '^[a-z_]{1,40}$'),
  args jsonb not null check (jsonb_typeof(args) = 'object' and pg_column_size(args) <= 16384),
  summary text not null check (char_length(summary) between 1 and 300),
  source text not null default 'MCP' check (char_length(source) between 1 and 120),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'canceled')),
  result text check (result is null or char_length(result) <= 4000),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists office_agent_actions_user_idx on public.office_agent_actions (user_id, created_at desc);
alter table public.office_agent_actions enable row level security;
-- 직접 접근은 막고 아래 함수로만(쓰기 모양·상태 전이를 한 곳에서 지킨다)
revoke all on table public.office_agent_actions from anon, authenticated;

-- 대기 변경 추가 — 조직이 있으면 그 조직의 손님 아닌 구성원이어야 한다(office_business_scope). 한 사람의 대기 중 행은 50개까지(폭주 방지)
create or replace function public.office_agent_action_add(p_org uuid, p_tool text, p_action text, p_args jsonb, p_summary text, p_source text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); new_id uuid;
begin
  if who is null then raise exception 'agent_action_forbidden' using errcode = '42501'; end if;
  if p_org is not null then perform public.office_business_scope(p_org, false); end if;
  if (select count(*) from public.office_agent_actions where user_id = who and status = 'pending') >= 50 then
    raise exception 'agent_action_limit' using errcode = '54000';
  end if;
  insert into public.office_agent_actions (user_id, org_id, tool, action, args, summary, source)
  values (who, p_org, p_tool, p_action, coalesce(p_args, '{}'::jsonb), left(btrim(coalesce(p_summary, '')), 300), left(coalesce(nullif(btrim(p_source), ''), 'MCP'), 120))
  returning id into new_id;
  return new_id;
end $$;

-- 내 대기 변경 목록 — 대기 중을 먼저, 최근 100개
create or replace function public.office_agent_action_list() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(a) - 'user_id' order by (a.status = 'pending') desc, a.created_at desc), '[]'::jsonb)
  from (select * from public.office_agent_actions where user_id = auth.uid() order by (status = 'pending') desc, created_at desc limit 100) a;
$$;

-- 실행 잡기 — 대기 중인 내 행만 '실행 중'으로 바꾸고 돌려준다. 두 번 눌러도 한 번만 잡힌다(없으면 null)
create or replace function public.office_agent_action_claim(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_agent_actions;
begin
  update public.office_agent_actions set status = 'running', decided_at = now()
    where id = p_id and user_id = auth.uid() and status = 'pending' returning * into r;
  if r.id is null then return null; end if;
  return to_jsonb(r) - 'user_id';
end $$;

-- 실행 결과 적기 — '실행 중'인 내 행만
create or replace function public.office_agent_action_finish(p_id uuid, p_ok boolean, p_result text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.office_agent_actions set status = case when p_ok then 'done' else 'failed' end, result = left(coalesce(p_result, ''), 4000)
    where id = p_id and user_id = auth.uid() and status = 'running';
  return found;
end $$;

-- 취소 — 대기 중인 내 행만
create or replace function public.office_agent_action_cancel(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.office_agent_actions set status = 'canceled', decided_at = now()
    where id = p_id and user_id = auth.uid() and status = 'pending';
  return found;
end $$;

-- 보존 30일(DB 위생 4) — 만든 지 30일 지난 행을 지운다. 대기열이라 기억 데이터가 아니다
create or replace function public.office_agent_action_sweep() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.office_agent_actions where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.office_agent_action_add(uuid, text, text, jsonb, text, text), public.office_agent_action_list(),
  public.office_agent_action_claim(uuid), public.office_agent_action_finish(uuid, boolean, text), public.office_agent_action_cancel(uuid),
  public.office_agent_action_sweep() from public, anon;
revoke all on function public.office_agent_action_sweep() from authenticated;
grant execute on function public.office_agent_action_add(uuid, text, text, jsonb, text, text), public.office_agent_action_list(),
  public.office_agent_action_claim(uuid), public.office_agent_action_finish(uuid, boolean, text), public.office_agent_action_cancel(uuid) to authenticated;

-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 등록하지 않는다. 같은 이름이면 갱신이라 다시 적용해도 하나다
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('office-agent-action-sweep', '41 18 * * *', $c$select public.office_agent_action_sweep()$c$);
  end if;
end $$;
