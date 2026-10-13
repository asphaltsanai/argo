-- 봇 롱폴 첫 조회에서 주인 플랜까지 판정 — 엣지의 별도 msgr_bot_gate 호출을 없앤다(2026-10-13 로그 수집 과금 축소, 총괄 결정 ①).
-- 배경: 엣지 msgr-bot은 getUpdates마다 msgr_bot_gate 1회 + msgr_bot_updates_with_delivery 여러 회를 불렀다(2시간 gate 5,268건).
--   엣지 인스턴스 메모리 기억(60초 'ok')은 요청이 거의 매번 다른 인스턴스에서 돌아 효과가 없었다(배포 뒤 실측: 실행 id 2,678개 / 요청 2,835건).
--   그래서 판정을 DB 쪽에서 합친다 — 새 엣지는 롱폴 첫 조회에만 gate => true를 넘기고, 막히면 'msgr_bot_plan_required'를 받는다(종전 403·Retry-After 그대로).
-- 판정 기준은 msgr_bot_gate와 같은 한 함수(아래에서 그대로 부른다 — 스위치 bot_plan_gate·msgr.pro_gate, 열린 중지 기록, is_pro_for).
-- 호환:
--   · 옛 엣지(v26 이하)는 인자 셋으로 부른다 → gate 기본값 false = 종전 동작(판정은 옛 엣지가 msgr_bot_gate로 따로 한다).
--   · 새 엣지가 이 마이그레이션 전의 DB를 만나면 네 인자 함수가 없어(PGRST202) 엣지가 종전 경로(msgr_bot_gate + 세 인자 호출)로 물러난다 — 판정이 빠지지 않는다.
--   · msgr_bot_gate 함수는 남긴다(옛 엣지·옛 연결 경로 msgr_bot_updates용).
-- 적용 순서: 이 마이그레이션 → 엣지 배포(엣지만 먼저 나가도 위 물러남으로 안전하지만, 그동안은 gate 호출이 줄지 않는다).
-- 같은 이름의 세 인자판을 지우고 네 인자판(기본값)을 만든다 — 둘을 같이 두면 PostgREST가 세 인자 호출을 고르지 못한다(PGRST203).
-- 쓰기: 막히면 dm_delivery_protocol 갱신 전에 예외로 끝난다(쓰기 0). 통과하면 종전과 같다(값이 다를 때만 1회).
-- 되돌리기: 아래 drop 뒤 20260914170000_msgr_bot_updates_idle_gate.sql의 세 인자 정의를 다시 만들고 같은 grant(엣지는 PGRST202를 보고 종전 경로로 돈다).
set local lock_timeout = '5s';

drop function if exists public.msgr_bot_updates_with_delivery(text, bigint, int);
create or replace function public.msgr_bot_updates_with_delivery(token text, after_id bigint default 0, lim int default 50, gate boolean default false) returns setof jsonb
language plpgsql security definer set search_path=public,pg_temp as $function$
declare old_protocol text;
begin
 if (msgr_bot_auth(token)).id is null then raise exception 'msgr_bot_unauthorized'; end if;
 -- 롱폴 첫 조회만(gate) — 같은 판정 함수. 막히면 쓰기 전에 끝낸다(엣지가 롱폴 시간만큼 붙잡았다가 403 + Retry-After)
 if gate and public.msgr_bot_gate(token) = 'plan_required' then raise exception 'msgr_bot_plan_required'; end if;
 update msgr_crews set dm_delivery_protocol=1 where id=(msgr_bot_auth(token)).crew_id and dm_delivery_protocol is distinct from 1;
 old_protocol:=current_setting('argo.msgr_delivery_protocol',true);
 perform set_config('argo.msgr_delivery_protocol','1',true);
 return query select * from msgr_bot_updates(token,after_id,lim);
 perform set_config('argo.msgr_delivery_protocol',coalesce(old_protocol,''),true);
end $function$;
revoke all on function public.msgr_bot_updates_with_delivery(text, bigint, int, boolean) from public;
grant execute on function public.msgr_bot_updates_with_delivery(text, bigint, int, boolean) to anon, authenticated, service_role; -- 라이브 세 인자판과 같은 권한(2026-10-13 proacl 확인)

notify pgrst, 'reload schema';
