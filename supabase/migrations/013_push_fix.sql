-- =====================================================================
-- v6.6 휴대폰 알림 고치기: 알림 키를 DB 에 보관 (수동 Secrets 필요 없음) · 시험 발송 결과 확인
--   SQL Editor 에 통째로 붙여넣고 Run (012 다음, 여러 번 실행해도 안전)
--   발송 함수(swift-handler)가 처음 실행될 때 키를 만들어 push_keys 에 넣는다
-- =====================================================================

-- 알림 키 (VAPID). 비공개키는 발송 함수(service role)만 읽는다
create table if not exists public.push_keys (
  id          int primary key default 1 check (id = 1),
  public_key  text not null,
  private_key text not null,
  created_at  timestamptz not null default now()
);
alter table public.push_keys enable row level security;
revoke all on public.push_keys from public, anon, authenticated;

-- 화면이 구독할 때 쓰는 공개키
create or replace function public.push_public_key()
returns text language sql stable security definer set search_path = public as $$
  select public_key from public.push_keys where id = 1;
$$;
revoke all on function public.push_public_key() from public, anon;
grant execute on function public.push_public_key() to authenticated;

-- 시험 발송: 나에게 보내고, 결과를 확인할 수 있게 요청 번호를 돌려준다
create or replace function public.push_test()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cfg public.push_config;
  n   int;
  rid bigint;
begin
  if not public.is_member() then raise exception '로그인이 필요합니다'; end if;
  select count(*) into n from public.push_subscriptions where user_id = auth.uid();
  insert into public.notifications (user_id, title, body, url)
  values (auth.uid(), '✅ 알림이 잘 옵니다', '이 기기로 컨펌·업무 알림을 받습니다', 'home.html');
  select * into cfg from public.push_config where id = 1;
  if not found then return jsonb_build_object('devices', n, 'request', null, 'reason', 'no_config'); end if;
  select net.http_post(
    url := cfg.url,
    body := jsonb_build_object('user_ids', array[auth.uid()], 'title', '✅ 알림이 잘 옵니다', 'body', '이 기기로 컨펌·업무 알림을 받습니다', 'url', 'home.html'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret)
  ) into rid;
  return jsonb_build_object('devices', n, 'request', rid);
end;
$$;
revoke all on function public.push_test() from public, anon;
grant execute on function public.push_test() to authenticated;

-- 시험 발송 결과 (발송 함수의 응답: {sent, removed, failed})
create or replace function public.push_test_result(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.is_member() then raise exception '로그인이 필요합니다'; end if;
  select status_code, content, error_msg into r from net._http_response where id = p_id;
  if not found then return null; end if;
  return jsonb_build_object('status', r.status_code, 'error', r.error_msg,
    'result', case when r.content ~ '^\s*\{' then r.content::jsonb end);
end;
$$;
revoke all on function public.push_test_result(bigint) from public, anon;
grant execute on function public.push_test_result(bigint) to authenticated;
