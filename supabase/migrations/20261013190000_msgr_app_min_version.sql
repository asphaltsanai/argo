-- 서버가 정하는 최소 앱 버전(유건 2026-10-13 "옛 버전 기기는 일시정지 화면에 업데이트 버튼을 띄우고, 무조건 업데이트하게 한다").
-- 이 버전보다 낮은 본체 앱은 기기 세션을 쓰지 않고(동기화·메신저·알림 주기 호출 0) 일시 정지 화면을 띄운다(src/app-gate.mjs).
-- 값은 msgr_settings 한 줄로만 바꾼다 — 행이 없으면 아무 기기도 막지 않는다(기본). 무료·Pro 모두 같은 값이다.
--   켜기:  insert into public.msgr_settings (key, value) values ('min_app_version', '0.1.107') on conflict (key) do update set value = excluded.value;
--   끄기:  delete from public.msgr_settings where key = 'min_app_version';
-- msgr_settings에는 푸시 비밀값 같은 다른 행도 있어 클라이언트가 표를 읽지 못한다(정책 없음). 이 함수는 정해진 키 하나만 돌려준다.
-- p_app = 'desktop'(본체) | 'messenger'(메신저 앱 — 지금은 앱이 묻지 않는다, 같은 장치를 쓸 자리). 그 밖의 값은 null.
create or replace function public.argo_min_app_version(p_app text default 'desktop') returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select s.value from public.msgr_settings s
     where s.key = case p_app when 'desktop' then 'min_app_version' when 'messenger' then 'min_app_version_messenger' end
$$;
revoke all on function public.argo_min_app_version(text) from public;
grant execute on function public.argo_min_app_version(text) to anon, authenticated, service_role;
