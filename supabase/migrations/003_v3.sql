-- =====================================================================
-- v3 업데이트: 업무 지시 · 상담→수임 · 수임료/입금/미수금 · 공지 · 자료실 · 휴대폰 푸시
--   Supabase SQL Editor 에 통째로 붙여넣고 Run (여러 번 실행해도 안전)
--   002_v2.sql 을 먼저 실행한 DB 에서 실행하세요. 기존 화면은 그대로 동작합니다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 업무 지시 · 할 일
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  memo        text,
  case_id     uuid references public.cases (id) on delete set null,
  assignee_id uuid not null references public.profiles (id),
  created_by  uuid not null default auth.uid() references public.profiles (id),
  due_date    date,
  status      text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists tasks_assignee_idx on public.tasks (assignee_id, status);
create index if not exists tasks_case_idx on public.tasks (case_id);

alter table public.tasks enable row level security;
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated using (public.is_member());
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_member() and (assignee_id = auth.uid() or created_by = auth.uid() or public.is_admin()))
  with check (public.is_member());
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_admin()));

-- 완료 시각 자동 기록
create or replace function public.tasks_done_at()
returns trigger language plpgsql as $$
begin
  if new.status = 'done' and (old is null or old.status <> 'done') then new.done_at := now(); end if;
  if new.status <> 'done' then new.done_at := null; end if;
  return new;
end;
$$;
drop trigger if exists tasks_done_at on public.tasks;
create trigger tasks_done_at before insert or update of status on public.tasks
  for each row execute function public.tasks_done_at();

-- ---------------------------------------------------------------------
-- 2. 상담 → 수임
-- ---------------------------------------------------------------------
create table if not exists public.consultations (
  id             uuid primary key default gen_random_uuid(),
  client_name    text not null check (length(trim(client_name)) > 0),
  phone          text,
  email          text,
  summary        text,
  status         text not null default 'new' check (status in ('new', 'followup', 'retained', 'dropped')),
  follow_up_date date,
  case_id        uuid references public.cases (id) on delete set null,
  created_by     uuid not null default auth.uid() references public.profiles (id),
  created_at     timestamptz not null default now()
);
alter table public.consultations enable row level security;
drop policy if exists consult_read on public.consultations;
create policy consult_read on public.consultations for select to authenticated using (public.is_member());
drop policy if exists consult_insert on public.consultations;
create policy consult_insert on public.consultations for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
drop policy if exists consult_update on public.consultations;
create policy consult_update on public.consultations for update to authenticated
  using (public.is_member()) with check (public.is_member());
drop policy if exists consult_delete on public.consultations;
create policy consult_delete on public.consultations for delete to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_admin()));

-- 수임: 상담 내용으로 사건을 만들고 연결
create or replace function public.retain_consultation(p_id uuid, p_case_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c   public.consultations;
  v_case uuid;
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  select * into c from public.consultations where id = p_id for update;
  if not found then raise exception '상담 기록을 찾을 수 없습니다'; end if;
  if c.case_id is not null then return c.case_id; end if;
  insert into public.cases (name, client, memo, created_by)
  values (coalesce(nullif(trim(p_case_name), ''), c.client_name || ' 사건'), c.client_name,
          concat_ws(E'\n', '[상담 내용]', c.summary,
                    case when c.phone is not null then '연락처: ' || c.phone end,
                    case when c.email is not null then '이메일: ' || c.email end),
          auth.uid())
  returning id into v_case;
  update public.consultations set status = 'retained', case_id = v_case where id = p_id;
  return v_case;
end;
$$;
revoke all on function public.retain_consultation(uuid, text) from public, anon;
grant execute on function public.retain_consultation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. 수임료 · 입금 · 미수금
-- ---------------------------------------------------------------------
alter table public.cases add column if not exists fee_amount bigint not null default 0;

create table if not exists public.payments (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.cases (id) on delete cascade,
  amount     bigint not null check (amount > 0),
  paid_on    date not null default current_date,
  method     text,
  memo       text,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists payments_case_idx on public.payments (case_id, paid_on);
alter table public.payments enable row level security;
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated using (public.is_member());
drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments for update to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_admin())) with check (public.is_member());
drop policy if exists payments_delete on public.payments;
create policy payments_delete on public.payments for delete to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_admin()));

create or replace view public.case_finance with (security_invoker = true) as
select c.id as case_id,
       c.name,
       c.status,
       c.fee_amount,
       coalesce((select sum(p.amount) from public.payments p where p.case_id = c.id), 0) as paid_amount,
       c.fee_amount - coalesce((select sum(p.amount) from public.payments p where p.case_id = c.id), 0) as unpaid_amount,
       coalesce((select cc.approved_amount from public.case_costs cc where cc.case_id = c.id), 0) as cost_amount
from public.cases c;
grant select on public.case_finance to authenticated;

-- ---------------------------------------------------------------------
-- 4. 공지사항 · 읽음 확인
-- ---------------------------------------------------------------------
create table if not exists public.notices (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(trim(title)) > 0),
  body       text,
  pinned     boolean not null default false,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);
create table if not exists public.notice_reads (
  notice_id uuid not null references public.notices (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (notice_id, user_id)
);
alter table public.notices enable row level security;
alter table public.notice_reads enable row level security;
drop policy if exists notices_read on public.notices;
create policy notices_read on public.notices for select to authenticated using (public.is_member());
drop policy if exists notices_write on public.notices;
create policy notices_write on public.notices for all to authenticated
  using (public.is_admin()) with check (public.is_admin() and created_by = auth.uid());
drop policy if exists notice_reads_read on public.notice_reads;
create policy notice_reads_read on public.notice_reads for select to authenticated using (public.is_member());

create or replace function public.read_notice(p_notice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  insert into public.notice_reads (notice_id, user_id) values (p_notice_id, auth.uid())
  on conflict do nothing;
end;
$$;
revoke all on function public.read_notice(uuid) from public, anon;
grant execute on function public.read_notice(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. 자료실 (자주 쓰는 양식 파일)
-- ---------------------------------------------------------------------
create table if not exists public.templates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  category    text not null default '기타',
  memo        text,
  file_path   text not null,
  file_name   text not null,
  file_type   text,
  file_size   bigint,
  uploaded_by uuid not null default auth.uid() references public.profiles (id),
  created_at  timestamptz not null default now()
);
alter table public.templates enable row level security;
drop policy if exists templates_read on public.templates;
create policy templates_read on public.templates for select to authenticated using (public.is_member());
drop policy if exists templates_insert on public.templates;
create policy templates_insert on public.templates for insert to authenticated
  with check (public.is_member() and uploaded_by = auth.uid() and file_path like auth.uid()::text || '/%');
drop policy if exists templates_delete on public.templates;
create policy templates_delete on public.templates for delete to authenticated
  using (public.is_member() and (uploaded_by = auth.uid() or public.is_admin()));

-- ---------------------------------------------------------------------
-- 6. 휴대폰 푸시 알림
--   push_config 에 Edge Function 주소가 들어가기 전까지는 아무것도 보내지 않는다.
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member());

-- 설정은 SQL Editor 에서만 (API 로는 읽을 수도 쓸 수도 없음)
create table if not exists public.push_config (
  id     int primary key default 1 check (id = 1),
  url    text not null,
  secret text not null
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net 을 켤 수 없어 휴대폰 푸시는 꺼진 상태로 둡니다: %', sqlerrm;
end $$;

create or replace function public.send_push(p_user_ids uuid[], p_title text, p_body text, p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare cfg public.push_config;
begin
  select * into cfg from public.push_config where id = 1;
  if not found or coalesce(array_length(p_user_ids, 1), 0) = 0 then return; end if;
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

create or replace function public.push_on_step()
returns trigger language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if new.state = 'current' and (tg_op = 'INSERT' or old.state is distinct from 'current') then
    select title into t from public.documents where id = new.doc_id;
    perform public.send_push(array[new.approver_id], '✍️ 컨펌 차례입니다', coalesce(t, ''), 'doc.html?id=' || new.doc_id);
  end if;
  return new;
end;
$$;
drop trigger if exists push_on_step on public.approval_steps;
create trigger push_on_step after insert or update of state on public.approval_steps
  for each row execute function public.push_on_step();

create or replace function public.push_on_task()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if new.assignee_id <> new.created_by then
    select name into who from public.profiles where id = new.created_by;
    perform public.send_push(array[new.assignee_id], '📌 새 업무: ' || new.title,
      coalesce(who, '') || case when new.due_date is not null then ' · 마감 ' || to_char(new.due_date, 'MM/DD') else '' end,
      'tasks.html');
  end if;
  return new;
end;
$$;
drop trigger if exists push_on_task on public.tasks;
create trigger push_on_task after insert on public.tasks
  for each row execute function public.push_on_task();

create or replace function public.push_on_notice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.send_push(
    (select array_agg(id) from public.profiles where active and id <> new.created_by),
    '📢 공지: ' || new.title, left(coalesce(new.body, ''), 80), 'notices.html#' || new.id);
  return new;
end;
$$;
drop trigger if exists push_on_notice on public.notices;
create trigger push_on_notice after insert on public.notices
  for each row execute function public.push_on_notice();

-- ---------------------------------------------------------------------
-- 7. 실시간 반영
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tasks', 'consultations', 'payments', 'notices', 'templates'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
