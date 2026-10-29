-- =====================================================================
-- v5.0 업데이트: 일 빨리 끝내기 · 근태/휴가/예약 · 통합 검색 · 안전/운영
--   SQL Editor 에 통째로 붙여넣고 Run (007 다음, 여러 번 실행해도 안전)
-- =====================================================================

do $$ begin
  if to_regclass('public.chat_rooms') is null then raise exception '007_chat.sql 을 먼저 실행해 주세요'; end if;
end $$;

-- 휴대폰 알림을 보낼 수 있으면 보낸다 (003 의 send_push)
create or replace function public.notify_users(p_ids uuid[], p_title text, p_body text, p_url text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.send_push(uuid[], text, text, text)') is null or coalesce(array_length(p_ids, 1), 0) = 0 then return; end if;
  execute 'select public.send_push($1, $2, $3, $4)' using p_ids, p_title, p_body, p_url;
end;
$$;
revoke all on function public.notify_users(uuid[], text, text, text) from public, anon, authenticated;

-- =====================================================================
-- ① 일 빨리 끝내기
-- =====================================================================

-- 1-1. 컨펌 기한
alter table public.documents add column if not exists due_date date;
alter table public.documents add column if not exists nudged_at timestamptz;

create or replace function public.set_doc_due(p_doc uuid, p_due date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.documents where id = p_doc and (uploader_id = auth.uid() or public.is_admin())) then
    raise exception '올린 사람이나 관리자만 기한을 정할 수 있습니다';
  end if;
  update public.documents set due_date = p_due where id = p_doc;
end;
$$;

-- 1-2. 확인 요청 다시 보내기: 안 본 사람 / 컨펌 안 한 사람에게 (10분에 한 번)
create or replace function public.nudge_doc(p_doc uuid, p_kind text)
returns int language plpgsql security definer set search_path = public as $$
declare
  d   public.documents;
  who text;
  ids uuid[];
begin
  select * into d from public.documents where id = p_doc for update;
  if not found or (d.uploader_id <> auth.uid() and not public.is_admin()) then
    raise exception '올린 사람이나 관리자만 요청할 수 있습니다';
  end if;
  if d.nudged_at > now() - interval '10 minutes' then
    raise exception '방금 요청했습니다. 10분 뒤에 다시 보낼 수 있습니다';
  end if;
  select name into who from public.profiles where id = auth.uid();
  if p_kind = 'approvers' then
    select array_agg(approver_id) into ids from public.approval_steps where doc_id = p_doc and state = 'current';
    perform public.notify_users(ids, '⏰ 컨펌 요청: ' || d.title,
      coalesce(who, '') || '님이 컨펌을 기다리고 있습니다' || coalesce(' · 기한 ' || to_char(d.due_date, 'MM/DD'), ''), 'doc.html?id=' || p_doc);
  else
    select array_agg(p.id) into ids from public.profiles p
     where p.active and p.id <> d.uploader_id
       and not exists (select 1 from public.document_views v where v.doc_id = p_doc and v.user_id = p.id);
    perform public.notify_users(ids, '👀 확인 부탁드립니다: ' || d.title, coalesce(who, '') || '님의 요청', 'doc.html?id=' || p_doc);
  end if;
  update public.documents set nudged_at = now() where id = p_doc;
  return coalesce(array_length(ids, 1), 0);
end;
$$;

-- 1-3. 코멘트 '해결됨'
alter table public.comments add column if not exists resolved_at timestamptz;
alter table public.comments add column if not exists resolved_by uuid references public.profiles (id) on delete set null;

create or replace function public.toggle_comment_resolved(p_comment uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare c public.comments; d public.documents;
begin
  select * into c from public.comments where id = p_comment for update;
  if not found then raise exception '코멘트를 찾을 수 없습니다'; end if;
  select * into d from public.documents where id = c.doc_id;
  if not public.is_member() or (c.user_id <> auth.uid() and d.uploader_id <> auth.uid() and not public.is_admin()) then
    raise exception '코멘트를 쓴 사람이나 문서를 올린 사람만 바꿀 수 있습니다';
  end if;
  if c.resolved_at is null then
    update public.comments set resolved_at = now(), resolved_by = auth.uid() where id = p_comment;
    return true;
  end if;
  update public.comments set resolved_at = null, resolved_by = null where id = p_comment;
  return false;
end;
$$;

-- 1-4. @멘션: 코멘트에 @이름이 있으면 그 사람에게 알림
create or replace function public.push_on_mention()
returns trigger language plpgsql security definer set search_path = public as $$
declare d public.documents; who text; ids uuid[];
begin
  if position('@' in coalesce(new.body, '')) = 0 then return new; end if;
  select array_agg(p.id) into ids from public.profiles p
   where p.active and p.id <> new.user_id and length(p.name) > 0
     and position('@' || p.name in new.body) > 0;
  if ids is null then return new; end if;
  select * into d from public.documents where id = new.doc_id;
  select name into who from public.profiles where id = new.user_id;
  perform public.notify_users(ids, '📣 ' || coalesce(who, '') || '님이 회원님을 언급: ' || coalesce(d.title, ''),
    left(new.body, 80), 'doc.html?id=' || new.doc_id);
  return new;
end;
$$;
drop trigger if exists push_on_mention on public.comments;
create trigger push_on_mention after insert on public.comments
  for each row execute function public.push_on_mention();

-- =====================================================================
-- ② 사무실 관리: 출퇴근 · 휴가/외근 · 회의실/차량 예약
-- =====================================================================

-- 2-1. 출퇴근
create table if not exists public.attendance (
  user_id   uuid not null references public.profiles (id) on delete cascade,
  work_date date not null default ((now() at time zone 'Asia/Seoul')::date),
  check_in  timestamptz,
  check_out timestamptz,
  note      text,
  primary key (user_id, work_date)
);
alter table public.attendance enable row level security;
drop policy if exists attendance_read on public.attendance;
create policy attendance_read on public.attendance for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
revoke insert, update, delete on public.attendance from anon, authenticated;

create or replace function public.clock(p_action text, p_note text default null)
returns public.attendance language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  r     public.attendance;
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  if p_action = 'in' then
    insert into public.attendance (user_id, work_date, check_in, note) values (auth.uid(), v_day, now(), nullif(trim(p_note), ''))
    on conflict (user_id, work_date) do update set check_in = coalesce(public.attendance.check_in, excluded.check_in)
    returning * into r;
  elsif p_action = 'out' then
    insert into public.attendance (user_id, work_date, check_out, note) values (auth.uid(), v_day, now(), nullif(trim(p_note), ''))
    on conflict (user_id, work_date) do update set check_out = now(), note = coalesce(excluded.note, public.attendance.note)
    returning * into r;
  else
    raise exception '잘못된 요청입니다';
  end if;
  return r;
end;
$$;

-- 2-2. 휴가 · 외근 · 출장 신청 → 승인자 컨펌 → 일정에 표시
create table if not exists public.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('연차', '오전반차', '오후반차', '외근', '출장', '병가', '경조', '기타')),
  start_date  date not null,
  end_date    date not null,
  reason      text,
  approver_id uuid not null references public.profiles (id),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_at  timestamptz,
  comment     text,
  created_at  timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists leave_dates_idx on public.leave_requests (start_date, end_date);
alter table public.leave_requests enable row level security;
-- 승인된 휴가·외근은 모두가 일정에서 볼 수 있게, 대기·반려는 본인·승인자·관리자만
drop policy if exists leave_read on public.leave_requests;
create policy leave_read on public.leave_requests for select to authenticated
  using (public.is_member() and (status = 'approved' or user_id = auth.uid() or approver_id = auth.uid() or public.is_admin()));
revoke insert, update, delete on public.leave_requests from anon, authenticated;

create or replace function public.request_leave(p_kind text, p_start date, p_end date, p_reason text, p_approver uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid; who text;
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  if p_approver = auth.uid() then raise exception '승인자는 다른 사람으로 지정해 주세요'; end if;
  if not exists (select 1 from public.profiles where id = p_approver and active) then raise exception '승인자를 찾을 수 없습니다'; end if;
  insert into public.leave_requests (user_id, kind, start_date, end_date, reason, approver_id)
  values (auth.uid(), p_kind, p_start, coalesce(p_end, p_start), nullif(trim(p_reason), ''), p_approver)
  returning id into v;
  select name into who from public.profiles where id = auth.uid();
  perform public.notify_users(array[p_approver], '🌴 ' || coalesce(who, '') || '님 ' || p_kind || ' 신청',
    to_char(p_start, 'MM/DD') || case when coalesce(p_end, p_start) <> p_start then ' ~ ' || to_char(p_end, 'MM/DD') else '' end
      || coalesce(' · ' || left(p_reason, 40), ''), 'office.html#leave');
  return v;
end;
$$;

create or replace function public.decide_leave(p_id uuid, p_decision text, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.leave_requests;
begin
  select * into r from public.leave_requests where id = p_id for update;
  if not found then raise exception '신청을 찾을 수 없습니다'; end if;
  if p_decision = 'cancelled' then
    if r.user_id <> auth.uid() then raise exception '본인 신청만 취소할 수 있습니다'; end if;
  else
    if p_decision not in ('approved', 'rejected') then raise exception '잘못된 요청입니다'; end if;
    if r.approver_id <> auth.uid() and not public.is_admin() then raise exception '승인자나 관리자만 처리할 수 있습니다'; end if;
    if r.status <> 'pending' then raise exception '이미 처리된 신청입니다'; end if;
  end if;
  update public.leave_requests set status = p_decision, decided_at = now(), comment = nullif(trim(p_comment), '') where id = p_id;
  if p_decision <> 'cancelled' then
    perform public.notify_users(array[r.user_id],
      case when p_decision = 'approved' then '✅ ' else '↩️ ' end || r.kind || ' 신청이 ' || case when p_decision = 'approved' then '승인' else '반려' end || '되었습니다',
      to_char(r.start_date, 'MM/DD') || coalesce(' · ' || left(p_comment, 40), ''), 'office.html#leave');
  end if;
end;
$$;

-- 2-3. 회의실 · 차량 예약 (같은 시간 겹치면 거부)
create table if not exists public.resources (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  kind   text not null default 'room' check (kind in ('room', 'car', 'etc')),
  active boolean not null default true
);
insert into public.resources (name, kind) values ('회의실', 'room'), ('법인차량', 'car') on conflict (name) do nothing;
alter table public.resources enable row level security;
drop policy if exists resources_read on public.resources;
create policy resources_read on public.resources for select to authenticated using (public.is_member());
drop policy if exists resources_admin on public.resources;
create policy resources_admin on public.resources for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.bookings (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources (id) on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title       text not null check (length(trim(title)) > 0),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists bookings_time_idx on public.bookings (resource_id, starts_at);
alter table public.bookings enable row level security;
drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to authenticated using (public.is_member());
drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to authenticated with check (public.is_member() and user_id = auth.uid());
drop policy if exists bookings_delete on public.bookings;
create policy bookings_delete on public.bookings for delete to authenticated using (user_id = auth.uid() or public.is_admin());

create or replace function public.bookings_no_overlap()
returns trigger language plpgsql as $$
declare who text;
begin
  perform pg_advisory_xact_lock(hashtext(new.resource_id::text));
  select p.name into who from public.bookings b join public.profiles p on p.id = b.user_id
   where b.resource_id = new.resource_id and b.id <> new.id and b.starts_at < new.ends_at and b.ends_at > new.starts_at limit 1;
  if found then raise exception '이미 예약된 시간입니다 (%)', who; end if;
  return new;
end;
$$;
drop trigger if exists bookings_no_overlap on public.bookings;
create trigger bookings_no_overlap before insert or update on public.bookings
  for each row execute function public.bookings_no_overlap();

-- =====================================================================
-- ④ 안전 · 운영: 활동 기록 · 저장공간 · 퇴사자 인계
-- =====================================================================
create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles (id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists activity_log_time_idx on public.activity_log (created_at desc);
alter table public.activity_log enable row level security;
drop policy if exists activity_admin_read on public.activity_log;
create policy activity_admin_read on public.activity_log for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.activity_log from anon, authenticated;

create or replace function public.log_activity(p_action text, p_target_type text, p_target_id text, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then return; end if;
  if p_action not in ('download', 'open_file', 'export') then return; end if;   -- 화면에서 남길 수 있는 기록만
  insert into public.activity_log (user_id, action, target_type, target_id, detail)
  values (auth.uid(), p_action, left(p_target_type, 40), left(p_target_id, 80), left(p_detail, 300));
end;
$$;

-- 삭제·권한 변경은 DB 가 직접 기록 (화면을 거치지 않아도 남는다)
create or replace function public.log_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log (user_id, action, target_type, target_id, detail)
  values (auth.uid(), 'delete', tg_table_name, old.id::text,
          left(coalesce(to_jsonb(old) ->> 'title', to_jsonb(old) ->> 'body', to_jsonb(old) ->> 'name', ''), 200));
  return old;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['documents', 'comments', 'templates', 'cases', 'tasks', 'notices', 'events'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists log_delete on public.%I', t);
      execute format('create trigger log_delete after delete on public.%I for each row execute function public.log_delete()', t);
    end if;
  end loop;
end $$;

create or replace function public.log_profile_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    insert into public.activity_log (user_id, action, target_type, target_id, detail)
    values (auth.uid(), 'profile', 'profiles', new.id::text,
            new.name || ': ' || old.role || '→' || new.role || ', ' || case when new.active then '사용' else '중지' end);
  end if;
  return new;
end;
$$;
drop trigger if exists log_profile_change on public.profiles;
create trigger log_profile_change after update on public.profiles
  for each row execute function public.log_profile_change();

-- 저장공간 사용량 (무료 플랜: DB 500MB, 파일 1GB)
create or replace function public.storage_usage()
returns table (db_bytes bigint, file_bytes bigint, file_count bigint)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자만 볼 수 있습니다'; end if;
  return query select pg_database_size(current_database())::bigint,
    coalesce((select sum(coalesce((o.metadata ->> 'size')::bigint, 0)) from storage.objects o where o.bucket_id = 'docs'), 0)::bigint,
    (select count(*) from storage.objects o where o.bucket_id = 'docs')::bigint;
end;
$$;

-- 퇴사자 인계: 계정 중지 + 진행 중 업무·컨펌·휴가 승인을 다른 직원에게
create or replace function public.offboard_user(p_user uuid, p_to uuid)
returns text language plpgsql security definer set search_path = public as $$
declare n_task int; n_step int := 0; n_leave int; s record;
begin
  if not public.is_admin() then raise exception '관리자만 가능합니다'; end if;
  if p_user = auth.uid() then raise exception '본인은 퇴사 처리할 수 없습니다'; end if;
  if p_user = p_to or not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception '인계받을 직원을 골라 주세요';
  end if;
  update public.tasks set assignee_id = p_to where assignee_id = p_user and status <> 'done';
  get diagnostics n_task = row_count;
  for s in select * from public.approval_steps where approver_id = p_user and state in ('current', 'waiting') loop
    if exists (select 1 from public.approval_steps where doc_id = s.doc_id and approver_id = p_to) then
      update public.approval_steps set state = 'skipped' where id = s.id;     -- 이미 컨펌자면 중복으로 넣지 않음
    else
      update public.approval_steps set approver_id = p_to where id = s.id;
    end if;
    n_step := n_step + 1;
  end loop;
  update public.leave_requests set approver_id = p_to where approver_id = p_user and status = 'pending';
  get diagnostics n_leave = row_count;
  update public.profiles set active = false where id = p_user;
  insert into public.activity_log (user_id, action, target_type, target_id, detail)
  values (auth.uid(), 'offboard', 'profiles', p_user::text,
          (select name from public.profiles where id = p_user) || ' → ' || (select name from public.profiles where id = p_to)
          || format(' (업무 %s · 컨펌 %s · 휴가승인 %s)', n_task, n_step, n_leave));
  return format('업무 %s건 · 컨펌 %s건 · 휴가 승인 %s건을 넘겼습니다', n_task, n_step, n_leave);
end;
$$;

-- =====================================================================
-- 매일 아침 9시(한국시간): 컨펌 기한 독촉 · 저장공간 경고 (pg_cron 이 켜져 있을 때)
-- =====================================================================
create or replace function public.daily_reminders()
returns void language plpgsql security definer set search_path = public as $$
declare
  d record;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_file bigint; v_db bigint;
begin
  for d in select doc.id, doc.title, doc.due_date, array_agg(s.approver_id) as ids
             from public.documents doc join public.approval_steps s on s.doc_id = doc.id and s.state = 'current'
            where doc.status = 'pending' and doc.due_date is not null and doc.due_date <= v_today + 1
            group by doc.id loop
    perform public.notify_users(d.ids,
      case when d.due_date < v_today then '🚨 컨펌 기한 지남: ' when d.due_date = v_today then '⏰ 오늘까지 컨펌: ' else '⏰ 내일까지 컨펌: ' end || d.title,
      '기한 ' || to_char(d.due_date, 'MM/DD'), 'doc.html?id=' || d.id);
  end loop;
  v_db := pg_database_size(current_database());
  select coalesce(sum(coalesce((metadata ->> 'size')::bigint, 0)), 0) into v_file from storage.objects where bucket_id = 'docs';
  if v_file > 0.8 * 1024 * 1024 * 1024 or v_db > 0.8 * 500 * 1024 * 1024 then
    perform public.notify_users((select array_agg(id) from public.profiles where active and role = 'admin'),
      '💾 저장공간 80% 넘음', format('파일 %s MB / 1024 MB · DB %s MB / 500 MB', v_file / 1048576, v_db / 1048576), 'admin.html#storage');
  end if;
end;
$$;
revoke all on function public.daily_reminders() from public, anon, authenticated;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'intranet-daily';
  perform cron.schedule('intranet-daily', '0 0 * * *', 'select public.daily_reminders()');
exception when others then
  raise notice '매일 알림 예약(pg_cron)을 켤 수 없어 건너뜁니다: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['set_doc_due(uuid,date)', 'nudge_doc(uuid,text)', 'toggle_comment_resolved(uuid)', 'clock(text,text)',
                           'request_leave(text,date,date,text,uuid)', 'decide_leave(uuid,text,text)',
                           'log_activity(text,text,text,text)', 'storage_usage()', 'offboard_user(uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- 목록 뷰에 새 컬럼(due_date)을 넣으려면 지우고 다시 만들어야 한다
drop view if exists public.document_summary;
create view public.document_summary with (security_invoker = true) as
select d.*,
       p.name as uploader_name,
       (select count(*) from public.document_views v where v.doc_id = d.id) as view_count,
       (select count(*) from public.comments c where c.doc_id = d.id) as comment_count,
       coalesce(
         (select s.approver_id from public.approval_steps s
           where s.doc_id = d.id and s.state = 'current' and s.approver_id = auth.uid() limit 1),
         (select s.approver_id from public.approval_steps s
           where s.doc_id = d.id and s.state = 'current' order by s.step_order limit 1)) as current_approver_id,
       c.name as case_name,
       not exists (select 1 from public.documents n where n.group_id = d.group_id and n.version > d.version) as is_latest
from public.documents d
join public.profiles p on p.id = d.uploader_id
left join public.cases c on c.id = d.case_id;
grant select on public.document_summary to authenticated;

do $$
declare t text;
begin
  foreach t in array array['leave_requests', 'bookings', 'attendance'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
