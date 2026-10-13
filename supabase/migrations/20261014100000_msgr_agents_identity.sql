-- 기억·공간 3단계 U1 "정체 층"(유건 결정 2026-10-13 G1 권장안 — artifacts/space-stage3/design.md E1·E2)
-- 에이전트 1명 = msgr_agents 1행. 지금의 msgr_crews 행은 그 에이전트의 "공간 자리"(조직마다 1행 + 개인 공간 1행 + 외부 봇 쌍둥이)로 다시 읽는다.
-- 같은 에이전트 = (주인 owner_user_id, 회사 ws_id, slug) — 메신저 agentKey·무료 플랜 계산(msgr_crews_pro_gate)이 이미 쓰는 키와 같다.
--
-- 하는 일(이 파일만 — 화면·플랜 계산·얼굴 이동은 0.1.109 U3·U4):
--   1) msgr_agents 표 + msgr_crews.agent_id 열(FK, 기본 NO ACTION — 계정 삭제 때 두 표가 auth.users에서 함께 캐스케이드돼 문장 끝에 검사하므로 막지 않는다)
--   2) 트리거: 자리 행 insert 때 agent_id를 (주인·회사·slug)로 찾거나 만들어 채운다. 옛 앱·옛 게이트웨이가 만드는 행도 붙는다.
--      클라이언트가 보낸 agent_id는 믿지 않고 늘 다시 정한다(남의 에이전트에 자리를 붙이지 못하게). 실패하면 agent_id null로 통과(fail-open — 자리 만들기를 막지 않는다).
--      update로 agent_id를 바꾸려 하면 같은 규칙으로 되돌린다(주인·회사·slug는 msgr_lock_crews가 잠가 바뀌지 않는다).
--   3) 한 번 채우기 msgr_agents_backfill(): 에이전트 insert + 자리 행 update. 멱등 — 두 번째 실행은 쓰기 0.
--      운영 2026-10-14 00:40 KST 읽기: 자리 2,027행 · 에이전트 1,031명 · 정책 잠금과 어긋난 allow 0행 · msgr_crews는 Realtime 발행 대상 아님.
--   4) RLS: 쓰기 정책 없음(트리거·채우기 함수만 쓴다 — 주인 쓰기는 U3에서 연다). 읽기 = 주인 + 그 에이전트의 조직 자리가 있는 조직의 멤버
--      (msgr_crews_select와 같은 범위: 개인 자리만 있는 에이전트는 주인만 본다).
--
-- 주기 쓰기 0: 새 주기 호출이 없다. 이미 에이전트가 있으면 트리거는 읽기만 한다(게이트웨이 upsert가 반복돼도 msgr_agents 쓰기 없음).
-- 기억 경로·공간 판정은 바꾸지 않는다 — agent_id는 "누구인가"만 더한다(판정은 여전히 자리 행의 org).
--
-- 되돌리기(데이터 손실 없음 — 자리 행·FK 자식은 손대지 않았다. 새 앱은 열이 없으면 agentKey로 폴백한다):
--   drop trigger if exists msgr_crews_zz_agent_link on public.msgr_crews;
--   drop trigger if exists msgr_crews_zz_agent_keep on public.msgr_crews;
--   drop function if exists public.msgr_crews_agent_link(); drop function if exists public.msgr_agents_backfill();
--   drop policy if exists msgr_agents_select on public.msgr_agents; -- 이 정책이 msgr_crews.agent_id를 읽어 열보다 먼저 지운다
--   alter table public.msgr_crews drop column if exists agent_id;
--   drop table if exists public.msgr_agents;

-- 1) 표
create table if not exists public.msgr_agents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  ws_id text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  unique (owner_user_id, ws_id, slug)
);
alter table public.msgr_agents enable row level security;
revoke all on public.msgr_agents from public, anon, authenticated;
grant select on public.msgr_agents to authenticated;
grant all on public.msgr_agents to service_role;

alter table public.msgr_crews add column if not exists agent_id uuid references public.msgr_agents (id);
create index if not exists msgr_crews_agent_idx on public.msgr_crews (agent_id);

-- 읽기: 주인, 또는 그 에이전트의 조직 자리가 있는 조직의 멤버. msgr_crews를 읽지만 msgr_crews 정책은 msgr_agents를 보지 않아 재귀가 없다.
drop policy if exists msgr_agents_select on public.msgr_agents;
create policy msgr_agents_select on public.msgr_agents for select to authenticated
  using (owner_user_id = (select auth.uid())
    or exists (select 1 from public.msgr_crews c where c.agent_id = msgr_agents.id and c.org_id is not null and public.msgr_is_member(c.org_id)));

-- 2) 트리거 — 이름 끝 zz: 같은 시점의 다른 BEFORE 트리거(정책·봇·플랜·회사 주인 관문, 이름순)가 다 통과한 뒤에 돈다.
create or replace function public.msgr_crews_agent_link() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare a uuid;
begin
  begin
    select id into a from public.msgr_agents where owner_user_id = new.owner_user_id and ws_id = new.ws_id and slug = new.slug;
    if a is null then
      insert into public.msgr_agents (owner_user_id, ws_id, slug) values (new.owner_user_id, new.ws_id, new.slug)
        on conflict (owner_user_id, ws_id, slug) do nothing returning id into a;
      if a is null then -- 동시에 같은 에이전트를 만든 쪽이 먼저 끝남
        select id into a from public.msgr_agents where owner_user_id = new.owner_user_id and ws_id = new.ws_id and slug = new.slug;
      end if;
    end if;
  exception when others then
    raise warning 'msgr_crews_agent_link: % (agent_id 없이 통과)', sqlerrm;
    a := null;
  end;
  new.agent_id := a;
  return new;
end $$;
revoke all on function public.msgr_crews_agent_link() from public, anon, authenticated;

drop trigger if exists msgr_crews_zz_agent_link on public.msgr_crews;
create trigger msgr_crews_zz_agent_link before insert on public.msgr_crews
  for each row execute function public.msgr_crews_agent_link();
-- agent_id를 바꾸는 update만(심박 등 다른 갱신에는 트리거 함수가 불리지 않는다 — WHEN은 열 단위로 평가)
drop trigger if exists msgr_crews_zz_agent_keep on public.msgr_crews;
create trigger msgr_crews_zz_agent_keep before update on public.msgr_crews
  for each row when (old.agent_id is distinct from new.agent_id) execute function public.msgr_crews_agent_link();

-- 3) 한 번 채우기(멱등). 정책 잠금 트리거는 update마다 allow를 정책 기본값과 대조해 어긋나면 막는다 — agent_id만 바꾸는 이 채우기가
--    잠금 전에 만든 행에서 실패하지 않게 이 트랜잭션 동안만 끈다(운영은 지금 0행이지만 적용 시점에 생길 수 있다). 다른 UPDATE 트리거는
--    바뀌는 열(status·role_text·allow 등)을 보므로 agent_id만 바꾸는 갱신에는 아무것도 하지 않는다.
create or replace function public.msgr_agents_backfill() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.msgr_agents (owner_user_id, ws_id, slug)
    select distinct c.owner_user_id, c.ws_id, c.slug from public.msgr_crews c where c.agent_id is null
    on conflict (owner_user_id, ws_id, slug) do nothing;
  if not exists (select 1 from public.msgr_crews where agent_id is null) then return 0; end if;
  alter table public.msgr_crews disable trigger msgr_crew_policy_gate;
  update public.msgr_crews c set agent_id = a.id from public.msgr_agents a
   where c.agent_id is null and a.owner_user_id = c.owner_user_id and a.ws_id = c.ws_id and a.slug = c.slug;
  get diagnostics n = row_count;
  alter table public.msgr_crews enable trigger msgr_crew_policy_gate;
  return n;
end $$;
revoke all on function public.msgr_agents_backfill() from public, anon, authenticated;

select public.msgr_agents_backfill();

notify pgrst, 'reload schema';
