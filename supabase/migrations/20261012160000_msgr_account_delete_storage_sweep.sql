-- 계정 삭제·보관 조직 영구 삭제가 저장소 파일을 진짜로 지우게(유건 승인 2026-10-12, 페퍼 경유 — 규칙 "DB·Storage 전송량 5":
-- SQL로 메타데이터만 지우거나 서비스 차단을 우회하지 않는다).
-- 종전(20260914200000·20260916150000): 두 함수가 storage-api 직접 삭제 가드를 GUC로 끄고 storage 행만 지웠다 — 행이 사라져 Storage API 목록에도
-- 안 나오는데 저장소 바이트는 남았다(두 함수 주석의 "알려진 한계").
-- 바꾼 것:
--   1) msgr_delete_me·msgr_purge_orgs는 storage 행을 건드리지 않는다(가드 GUC도 쓰지 않는다). 본문은 종전 마지막 정의 그대로에서 그 줄만 뺐다.
--   2) 조직 첨부(msgr/<org>/<channel>/…)·개인 방 첨부(msgr/p/<channel>/…): 조직·방이 지워지면(채널 org_id on delete cascade, 계정 삭제의
--      혼자 남은 개인 방 삭제) 기존 정리 후보 msgr_storage_sweep_list("방이 없는 객체")에 그대로 잡힌다 — 바꾸지 않는다.
--   3) 아바타(msgr-avatars/avatars/<uid>/…): 새 후보 함수 msgr_storage_sweep_avatars — 경로의 uid가 auth.users에 없는 공개 아바타.
--      정리 엣지가 버킷별로 지운다(supabase/functions/msgr-storage-sweep). 경로가 uid 모양이 아니면 건드리지 않는다.
--   4) msgr_storage_sweep_kick은 두 후보 중 하나라도 있으면 엣지를 부른다(유휴 = 호출 0 그대로).
-- 지워지기까지의 틈: 계정 삭제 뒤 다음 정각+17분 크론까지(최대 1시간). 그동안 msgr 첨부는 방이 없어 서명 URL을 못 만들고(권한 거부),
-- 공개 아바타 URL은 열린다 — 프로필 행이 함께 지워져 앱 어디에서도 그 URL을 보여 주지 않는다.
-- 부하: 계정 삭제·purge의 쓰기는 줄어든다(storage 행 삭제 없음). 정리는 종전과 같은 1시간 크론, 후보가 없으면 호출 0.
--   아바타 후보 조회는 msgr-avatars 버킷 행(운영 33행, 10/12)과 auth.users 색인 조회 — 크론 1회에 한 번.
-- 되돌리기: 20260916150000의 msgr_delete_me·20260914200000의 msgr_purge_orgs·20261011150000의 msgr_storage_sweep_kick 정의를 다시 적용한다
--   (msgr_storage_sweep_avatars는 남겨도 무해 — 엣지가 부르지 않으면 쓰이지 않는다).
-- 적용: bash scripts/msgr-live-apply.sh 20261012160000_msgr_account_delete_storage_sweep  →  엣지 msgr-storage-sweep 재배포(--no-verify-jwt)

-- 1) 계정 삭제 — 20260916150000 정의에서 저장소 줄만 뺐다
create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  blocked text;
  owned uuid[];
  n_orgs int := 0;
begin
  if me is null then raise exception 'msgr_unauthenticated'; end if;

  -- 다른 활성 멤버(서비스 계정·만료 게스트 제외)가 있는 소유 조직 — 보관 중이어도 남의 기록이므로 이전이 먼저(2R H-1·M-1)
  select string_agg(o.name, ', ' order by o.name) into blocked
    from public.msgr_orgs o
   where o.owner_user_id = me
     and (o.deleted_at is null or o.deleted_at > now() - interval '30 days') -- 유예가 끝난 보관 조직은 어차피 purge 대상 — 이전을 요구하면 복구도 목록도 없는 막다른 길(3R M2R-3)
     and exists (select 1 from public.msgr_org_members m
                  where m.org_id = o.id and m.user_id <> me and m.removed_at is null
                    and (m.expires_at is null or m.expires_at > now())
                    and (o.service_user_id is null or m.user_id <> o.service_user_id));
  if blocked is not null then
    raise exception 'msgr_owner_transfer_required: %', blocked;
  end if;

  perform set_config('argo.msgr_account_delete', '1', true); -- 이 함수 안에서만 가드 통과. 끝·예외에서 되돌린다(2R H-2)

  -- 다른 조직에 남는 내 흔적 중 FK가 사용자 삭제를 막는 것(created_by/updated_by NOT NULL·규칙 없음)은 조직 소유자에게 넘긴다
  update public.msgr_channels c set created_by = o.owner_user_id from public.msgr_orgs o where o.id = c.org_id and c.created_by = me and o.owner_user_id <> me;
  -- 개인 공간(조직 밖) 1:1 — 조직 소유자가 없으니 남은 상대에게 넘기고, 혼자 남은 방은 지운다.
  -- 이걸 빠뜨리면 msgr_channels.created_by FK가 auth.users 삭제를 막아 **계정 삭제 전체가 실패**한다(전수 수색 P3-16).
  update public.msgr_channels c set created_by = (
      select m.member_id from public.msgr_channel_members m
       where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> me limit 1)
    where c.org_id is null and c.created_by = me
      and exists (select 1 from public.msgr_channel_members m
                   where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> me);
  delete from public.msgr_channels c where c.org_id is null and c.created_by = me;
  update public.msgr_org_docs d set created_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.created_by = me and o.owner_user_id <> me;
  update public.msgr_org_docs d set updated_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.updated_by = me and o.owner_user_id <> me;
  update public.msgr_work_runs w set created_by = o.owner_user_id from public.msgr_orgs o where o.id = w.org_id and w.created_by = me and o.owner_user_id <> me;
  update public.msgr_channel_members set added_by = null where added_by = me;
  update public.msgr_crew_approvals set decided_by = null where decided_by = me;
  -- 회사 노드 서비스 계정·후계자·이전 제안은 auth.users FK(on delete set null)가 비운다 — 캐스케이드 UPDATE는 msgr_org_before_update의 캐스케이드 분기가 감사(org.service_account·org.successor)를 직접 남긴다(2R C-2·C-3, 3R H2R-1·M2R-5). 명시 해제 3줄은 변이로 죽은 코드임이 실증돼 지웠다.

  -- 내 채널 멤버십(폴리모픽 — FK 없음)과 조직 멤버십 종료(오프보딩 사슬: 크루 분리·채널 회수)
  delete from public.msgr_channel_members where member_kind = 'user' and member_id = me;
  update public.msgr_org_members set removed_at = now() where user_id = me and removed_at is null;

  -- 나만 남은 소유 조직: 조직(자식 cascade — 채널·메시지·첨부 행) 하드 삭제. 위 검사로 다른 활성 멤버가 있는 조직은 여기 없다.
  -- 저장소 파일은 여기서 지우지 않는다(20261012160000) — 방이 사라진 msgr 객체와 계정이 사라진 아바타는 정리 엣지(msgr-storage-sweep)가
  -- 1시간 안에 Storage API로 바이트까지 지운다. 종전처럼 storage 행만 지우면 저장소 바이트가 영영 남았다.
  select coalesce(array_agg(id), '{}'::uuid[]) into owned from public.msgr_orgs where owner_user_id = me;
  if array_length(owned, 1) > 0 then
    delete from public.msgr_orgs where id = any (owned);
    get diagnostics n_orgs = row_count;
  end if;
  if to_regclass('public.device_keys') is not null then
    update public.device_keys set revoked_at = now() where user_id = me and revoked_at is null;
  end if;

  -- 프로필·친구·푸시 토큰·읽음·반응·핀·알림 경로·멤버십·크루·초대는 auth.users FK cascade
  delete from auth.users where id = me;
  perform set_config('argo.msgr_account_delete', '', true);
  return jsonb_build_object('deleted_orgs', n_orgs);
exception when others then
  perform set_config('argo.msgr_account_delete', '', true);
  raise;
end $$;
revoke all on function public.msgr_delete_me() from public, anon;
grant execute on function public.msgr_delete_me() to authenticated;

-- 2) 보관 조직 영구 삭제(30일 유예 뒤 서비스 잡) — 20260914200000 정의에서 저장소 줄만 뺐다
create or replace function public.msgr_purge_orgs() returns int
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; ids uuid[];
begin
  if auth.uid() is not null then raise exception 'msgr_service_only'; end if;
  select array_agg(id) into ids from public.msgr_orgs where deleted_at is not null and deleted_at < now() - interval '30 days';
  if ids is null then return 0; end if;
  -- 첨부 파일은 여기서 지우지 않는다(20261012160000) — 조직이 지워지면 방도 함께 지워지고(cascade), 방이 없는 msgr 객체를 정리 엣지가 Storage API로 지운다
  delete from public.msgr_orgs where id = any (ids);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.msgr_purge_orgs() from public, anon, authenticated;

-- 3) 아바타 정리 후보 — 경로 avatars/<uid>/…의 uid가 auth.users에 없는 공개 아바타. 서비스 역할(엣지)만. 오래된 것부터 p_limit개.
create or replace function public.msgr_storage_sweep_avatars(p_limit int default 200) returns setof text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return query
    select o.name from storage.objects o
     where o.bucket_id = 'msgr-avatars'
       and (storage.foldername(o.name))[1] = 'avatars'
       and public.msgr_uuid_or_null((storage.foldername(o.name))[2]) is not null
       and not exists (select 1 from auth.users u where u.id = public.msgr_uuid_or_null((storage.foldername(o.name))[2]))
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $$;
revoke all on function public.msgr_storage_sweep_avatars(int) from public, anon, authenticated;
grant execute on function public.msgr_storage_sweep_avatars(int) to service_role;

-- 4) 크론 → 엣지 — 20261011150000 정의에 아바타 후보 한 줄
create or replace function public.msgr_storage_sweep_kick() returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare url text; sec text;
begin
  select value into url from public.msgr_settings where key = 'storage_sweep_url';
  select value into sec from public.msgr_settings where key = 'storage_sweep_secret';
  if coalesce(url, '') = '' or coalesce(sec, '') = '' then return false; end if;
  if not exists (select 1 from public.msgr_storage_sweep_list(1)) and not exists (select 1 from public.msgr_storage_sweep_avatars(1)) then return false; end if;
  perform net.http_post(url := url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || sec),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
  return true;
end $$;
revoke all on function public.msgr_storage_sweep_kick() from public, anon, authenticated;

notify pgrst, 'reload schema';
