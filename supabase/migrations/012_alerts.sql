-- =====================================================================
-- v6.4 알림 강화: 🔔 알림함 · 안 한 일 자동 재알림 · 알림 시험 보내기
--   SQL Editor 에 통째로 붙여넣고 Run (011 다음, 여러 번 실행해도 안전)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 알림함: 휴대폰 알림을 못 받았어도 인트라넷 안 🔔 에 모두 남는다
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  body       text,
  url        text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_user on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
drop policy if exists noti_read on public.notifications;
create policy noti_read on public.notifications for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.notifications from authenticated, anon;

create or replace function public.read_notifications(p_ids bigint[] default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
end;
$$;
revoke all on function public.read_notifications(bigint[]) from public, anon;
grant execute on function public.read_notifications(bigint[]) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- 모든 알림이 거치는 send_push 를 다시 만든다: 먼저 알림함에 넣고, 휴대폰 푸시를 보낸다
--   (채팅은 채팅 배지가 따로 있으니 알림함에는 넣지 않는다)
create or replace function public.send_push(p_user_ids uuid[], p_title text, p_body text, p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare cfg public.push_config;
begin
  if coalesce(array_length(p_user_ids, 1), 0) = 0 then return; end if;
  if coalesce(p_url, '') not like 'chat.html%' then
    insert into public.notifications (user_id, title, body, url)
    select distinct u, left(p_title, 200), left(p_body, 500), p_url
      from unnest(p_user_ids) u where exists (select 1 from public.profiles p where p.id = u);
  end if;
  select * into cfg from public.push_config where id = 1;
  if not found then return; end if;
  perform net.http_post(
    url := cfg.url,
    body := jsonb_build_object('user_ids', p_user_ids, 'title', p_title, 'body', p_body, 'url', p_url),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret)
  );
exception when others then
  -- 알림이 실패해도 업무(문서·컨펌·업무 지시)는 막지 않는다
  raise warning 'send_push 실패: %', sqlerrm;
end;
$$;
revoke all on function public.send_push(uuid[], text, text, text) from public, anon, authenticated;

-- 알림 시험: 나에게 한 번 보내 본다 (휴대폰에 오는지 확인용)
create or replace function public.send_test_push()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_member() then raise exception '로그인이 필요합니다'; end if;
  select count(*) into n from public.push_subscriptions where user_id = auth.uid();
  perform public.send_push(array[auth.uid()], '✅ 알림이 잘 옵니다', '이 기기로 컨펌·업무 알림을 받습니다', 'home.html');
  return n;
end;
$$;
revoke all on function public.send_test_push() from public, anon;
grant execute on function public.send_test_push() to authenticated;

-- ---------------------------------------------------------------------
-- 2. 재알림: 컨펌을 3시간 넘게 안 하면 다시, 마감 지난/오늘 마감 업무는 아침에 한 번
--    평일 9~19시(한국 시간)에만, 한 사람에게 한 번에 묶어서 보낸다
-- ---------------------------------------------------------------------
alter table public.approval_steps add column if not exists current_since timestamptz;
alter table public.approval_steps add column if not exists reminded_at timestamptz;
alter table public.approval_steps add column if not exists remind_count int not null default 0;
alter table public.tasks add column if not exists reminded_on date;

-- 차례가 된 시각을 남긴다
create or replace function public.step_current_since()
returns trigger language plpgsql as $$
begin
  if new.state = 'current' and (tg_op = 'INSERT' or old.state is distinct from 'current') then
    new.current_since := now(); new.reminded_at := null; new.remind_count := 0;
  end if;
  return new;
end;
$$;
drop trigger if exists step_current_since on public.approval_steps;
create trigger step_current_since before insert or update of state on public.approval_steps
  for each row execute function public.step_current_since();
update public.approval_steps s set current_since = d.created_at
  from public.documents d where s.doc_id = d.id and s.state = 'current' and s.current_since is null;

drop function if exists public.remind_pending();
create or replace function public.remind_pending(p_force boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare
  kst  timestamp := now() at time zone 'Asia/Seoul';
  r    record;
  sent int := 0;
begin
  if not p_force and (extract(isodow from kst) > 5 or extract(hour from kst) not between 9 and 18) then return 0; end if;

  -- 컨펌 대기: 차례가 된 지 3시간 넘었고, 마지막 재알림도 3시간 넘었고, 최대 3번까지
  for r in
    select s.approver_id u, count(*) n, string_agg(d.title, ', ' order by s.current_since) titles, array_agg(s.id) ids,
           max(extract(epoch from now() - s.current_since) / 3600)::int hrs
      from public.approval_steps s join public.documents d on d.id = s.doc_id
      join public.profiles p on p.id = s.approver_id and p.active
     where s.state = 'current' and d.status = 'pending'
       and s.current_since < now() - interval '3 hours'
       and coalesce(s.reminded_at, s.current_since) < now() - interval '3 hours'
       and s.remind_count < 3
     group by s.approver_id
  loop
    perform public.send_push(array[r.u],
      case when (select title from public.profiles where id = r.u) = '변호사'
           then '⚖️ ' || public.honor(r.u) || ', 검토 기다리는 문서 ' || r.n || '건'
           else '⏰ ' || public.honor(r.u) || ', 컨펌 기다리는 문서 ' || r.n || '건' end,
      left(r.titles, 120) || ' · ' || r.hrs || '시간째 대기',
      case when r.n = 1 then (select 'doc.html?id=' || doc_id from public.approval_steps where id = r.ids[1]) else 'index.html?tab=myturn' end);
    update public.approval_steps set reminded_at = now(), remind_count = remind_count + 1 where id = any (r.ids);
    sent := sent + 1;
  end loop;

  -- 업무: 오늘 마감이거나 지난 것, 하루 한 번
  for r in
    select t.assignee_id u, count(*) n, string_agg(t.title, ', ' order by t.due_date) titles, array_agg(t.id) ids,
           count(*) filter (where t.due_date < kst::date) late
      from public.tasks t join public.profiles p on p.id = t.assignee_id and p.active
     where t.status <> 'done' and t.due_date <= kst::date
       and (t.reminded_on is null or t.reminded_on < kst::date)
     group by t.assignee_id
  loop
    perform public.send_push(array[r.u],
      '📌 ' || public.honor(r.u) || ', ' || case when r.late > 0 then '마감 지난 업무 포함 ' else '오늘 마감 업무 ' end || r.n || '건',
      left(r.titles, 120), 'tasks.html');
    update public.tasks set reminded_on = kst::date where id = any (r.ids);
    sent := sent + 1;
  end loop;
  return sent;
end;
$$;
revoke all on function public.remind_pending(boolean) from public, anon, authenticated;

-- 매시 7분에 자동 실행 (pg_cron). 안 켜져 있으면 안내만 하고 넘어간다
do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'intranet-remind';
  perform cron.schedule('intranet-remind', '7 * * * *', 'select public.remind_pending()');
exception when others then
  raise notice '자동 재알림을 쓰려면 Database → Extensions 에서 pg_cron 을 켠 뒤 이 파일을 다시 실행하세요 (%)', sqlerrm;
end $$;
