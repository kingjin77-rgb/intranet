-- =====================================================================
-- 미니 인트라넷 스키마 (Supabase SQL Editor 에 통째로 붙여넣고 Run)
--   문서 공유 · 열람기록 · 코멘트 · 순차 결재
--   여러 번 실행해도 안전하도록 작성됨 (if not exists / or replace)
--   ※ 이 파일을 실행한 뒤 migrations/002_v2.sql → 003_v3.sql → 004_alerts.sql → 005_v33.sql → 006_files.sql → 007_chat.sql 순서로 이어서 실행하세요
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------

-- 가입 허용 명단: 여기에 있는 이메일만 로그인(가입)할 수 있다.
create table if not exists public.allowed_emails (
  email      text primary key check (email = lower(email)),
  name       text not null,
  dept       text,
  role       text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  name       text not null,
  dept       text,
  role       text not null default 'member' check (role in ('member', 'admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  description text,
  file_path   text not null,
  file_name   text not null,
  file_type   text not null,
  file_size   bigint,
  uploader_id uuid not null references public.profiles (id),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'none')),
  created_at  timestamptz not null default now()
);

create table if not exists public.document_views (
  doc_id          uuid not null references public.documents (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  first_viewed_at timestamptz not null default now(),
  last_viewed_at  timestamptz not null default now(),
  view_count      int not null default 1,
  primary key (doc_id, user_id)
);

create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  doc_id     uuid not null references public.documents (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (length(trim(body)) > 0),
  page_no    int,
  created_at timestamptz not null default now()
);
create index if not exists comments_doc_idx on public.comments (doc_id, created_at);

create table if not exists public.approval_steps (
  id          uuid primary key default gen_random_uuid(),
  doc_id      uuid not null references public.documents (id) on delete cascade,
  step_order  int not null,
  approver_id uuid not null references public.profiles (id),
  state       text not null default 'waiting' check (state in ('waiting', 'current', 'approved', 'rejected', 'skipped')),
  comment     text,
  acted_at    timestamptz,
  unique (doc_id, step_order)
);
create index if not exists approval_steps_approver_idx on public.approval_steps (approver_id, state);

-- ---------------------------------------------------------------------
-- 2. 헬퍼 함수
-- ---------------------------------------------------------------------

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- 신규 가입 시: 허용 명단에 없으면 가입 자체를 거부, 있으면 프로필 생성
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a public.allowed_emails;
begin
  select * into a from public.allowed_emails where email = lower(new.email);
  if not found then
    raise exception '초대되지 않은 이메일입니다: %', new.email;
  end if;
  insert into public.profiles (id, email, name, dept, role)
  values (new.id, lower(new.email), a.name, a.dept, a.role)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 3. RPC (클라이언트는 상태 변경을 반드시 이 함수들로만 한다)
-- ---------------------------------------------------------------------

-- 문서 + 결재선을 한 번에 등록. approvers 가 비어 있으면 결재 없는 공유 문서.
create or replace function public.create_document(
  p_title text, p_description text,
  p_file_path text, p_file_name text, p_file_type text, p_file_size bigint,
  p_approvers uuid[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_doc uuid;
  v_n   int := coalesce(array_length(p_approvers, 1), 0);
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  if p_file_path not like auth.uid()::text || '/%' then
    raise exception '잘못된 파일 경로입니다';
  end if;
  if v_n <> (select count(distinct x) from unnest(p_approvers) x) then
    raise exception '컨펌자가 중복되었습니다';
  end if;
  if v_n > 0 and v_n <> (select count(*) from public.profiles where id = any (p_approvers) and active) then
    raise exception '존재하지 않거나 비활성화된 컨펌자가 있습니다';
  end if;

  insert into public.documents (title, description, file_path, file_name, file_type, file_size, uploader_id, status)
  values (trim(p_title), nullif(trim(p_description), ''), p_file_path, p_file_name, p_file_type, p_file_size,
          auth.uid(), case when v_n = 0 then 'none' else 'pending' end)
  returning id into v_doc;

  insert into public.approval_steps (doc_id, step_order, approver_id, state)
  select v_doc, o, a, case when o = 1 then 'current' else 'waiting' end
  from unnest(p_approvers) with ordinality as t(a, o);

  return v_doc;
end;
$$;

-- 결재: 내 차례(current)인 단계만 승인/반려 가능
create or replace function public.act_on_step(p_step_id uuid, p_decision text, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.approval_steps;
begin
  if p_decision not in ('approved', 'rejected') then raise exception '잘못된 컨펌 값입니다'; end if;
  if p_decision = 'rejected' and coalesce(trim(p_comment), '') = '' then
    raise exception '반려 사유를 입력해 주세요';
  end if;

  select * into s from public.approval_steps where id = p_step_id for update;
  if not found then raise exception '컨펌 단계를 찾을 수 없습니다'; end if;
  if s.approver_id <> auth.uid() or not public.is_member() then raise exception '본인 컨펌 차례가 아닙니다'; end if;
  if s.state <> 'current' then raise exception '이미 처리되었거나 아직 차례가 아닙니다'; end if;

  update public.approval_steps
     set state = p_decision, comment = nullif(trim(p_comment), ''), acted_at = now()
   where id = s.id;

  if p_decision = 'rejected' then
    update public.approval_steps set state = 'skipped' where doc_id = s.doc_id and state = 'waiting';
    update public.documents set status = 'rejected' where id = s.doc_id;
  elsif exists (select 1 from public.approval_steps where doc_id = s.doc_id and step_order > s.step_order) then
    update public.approval_steps set state = 'current'
     where doc_id = s.doc_id
       and step_order = (select min(step_order) from public.approval_steps
                          where doc_id = s.doc_id and step_order > s.step_order);
  else
    update public.documents set status = 'approved' where id = s.doc_id;
  end if;
end;
$$;

-- 열람 기록 (문서 열 때마다 호출)
create or replace function public.record_view(p_doc_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  insert into public.document_views (doc_id, user_id)
  values (p_doc_id, auth.uid())
  on conflict (doc_id, user_id) do update
     set last_viewed_at = now(), view_count = public.document_views.view_count + 1;
end;
$$;

-- 관리자: 직원 권한/활성 변경
create or replace function public.admin_update_profile(p_id uuid, p_name text, p_dept text, p_role text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자만 가능합니다'; end if;
  if p_id = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception '본인의 관리자 권한은 해제할 수 없습니다';
  end if;
  update public.profiles
     set name = coalesce(nullif(trim(p_name), ''), name), dept = nullif(trim(p_dept), ''),
         role = p_role, active = p_active
   where id = p_id;
end;
$$;

-- 목록 화면용 요약 뷰 (호출자 권한으로 실행)
create or replace view public.document_summary with (security_invoker = true) as
select d.*,
       p.name as uploader_name,
       (select count(*) from public.document_views v where v.doc_id = d.id) as view_count,
       (select count(*) from public.comments c where c.doc_id = d.id) as comment_count,
       (select s.approver_id from public.approval_steps s where s.doc_id = d.id and s.state = 'current') as current_approver_id
from public.documents d
join public.profiles p on p.id = d.uploader_id;

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------
alter table public.allowed_emails enable row level security;
alter table public.profiles       enable row level security;
alter table public.documents      enable row level security;
alter table public.document_views enable row level security;
alter table public.comments       enable row level security;
alter table public.approval_steps enable row level security;

-- 허용 명단: 관리자만
drop policy if exists allowed_admin on public.allowed_emails;
create policy allowed_admin on public.allowed_emails
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 프로필: 직원끼리 조회, 본인 이름/부서만 수정 (권한·활성은 RPC 로만)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (public.is_member());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() and public.is_member()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (name, dept) on public.profiles to authenticated;

-- 문서: 직원 모두 조회, 등록은 RPC, 삭제는 올린 사람 또는 관리자
drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents for select to authenticated using (public.is_member());
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated
  using (public.is_member() and (uploader_id = auth.uid() or public.is_admin()));

drop policy if exists views_read on public.document_views;
create policy views_read on public.document_views for select to authenticated using (public.is_member());

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select to authenticated using (public.is_member());
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists steps_read on public.approval_steps;
create policy steps_read on public.approval_steps for select to authenticated using (public.is_member());

revoke all on function public.create_document(text, text, text, text, text, bigint, uuid[]) from public, anon;
revoke all on function public.act_on_step(uuid, text, text) from public, anon;
revoke all on function public.record_view(uuid) from public, anon;
revoke all on function public.admin_update_profile(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.create_document(text, text, text, text, text, bigint, uuid[]) to authenticated;
grant execute on function public.act_on_step(uuid, text, text) to authenticated;
grant execute on function public.record_view(uuid) to authenticated;
grant execute on function public.admin_update_profile(uuid, text, text, text, boolean) to authenticated;
grant select on public.document_summary to authenticated;

-- ---------------------------------------------------------------------
-- 5. 파일 저장소 (비공개 버킷, 50MB 제한)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('docs', 'docs', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists docs_read on storage.objects;
create policy docs_read on storage.objects for select to authenticated
  using (bucket_id = 'docs' and public.is_member());
drop policy if exists docs_upload on storage.objects;
create policy docs_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'docs' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists docs_delete on storage.objects;
create policy docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ---------------------------------------------------------------------
-- 6. 실시간 반영 (코멘트·열람·결재)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['comments', 'document_views', 'approval_steps', 'documents'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. 첫 관리자 등록 — 아래 이메일/이름을 본인 것으로 바꿔서 실행
-- ---------------------------------------------------------------------
-- insert into public.allowed_emails (email, name, dept, role)
-- values ('admin@example.com', '홍길동', '경영지원', 'admin')
-- on conflict (email) do update set role = 'admin';
