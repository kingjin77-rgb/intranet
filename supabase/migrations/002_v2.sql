-- =====================================================================
-- v2 업데이트: 사건별 묶기 · 기일/일정 · 문서 수정본(재상신) · 양식 컨펌
--   Supabase SQL Editor 에 통째로 붙여넣고 Run (여러 번 실행해도 안전)
--   기존 화면(이전 버전)도 그대로 동작하도록 추가만 한다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 사건
-- ---------------------------------------------------------------------
create table if not exists public.cases (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  client     text,
  court      text,
  case_no    text,
  memo       text,
  status     text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.cases enable row level security;
drop policy if exists cases_read on public.cases;
create policy cases_read on public.cases for select to authenticated using (public.is_member());
drop policy if exists cases_insert on public.cases;
create policy cases_insert on public.cases for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
drop policy if exists cases_update on public.cases;
create policy cases_update on public.cases for update to authenticated
  using (public.is_member()) with check (public.is_member());
drop policy if exists cases_delete on public.cases;
create policy cases_delete on public.cases for delete to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_admin()));

-- ---------------------------------------------------------------------
-- 2. 기일 · 일정
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid references public.cases (id) on delete set null,
  title      text not null check (length(trim(title)) > 0),
  starts_at  timestamptz not null,
  all_day    boolean not null default false,
  kind       text not null default 'etc' check (kind in ('hearing', 'deadline', 'meeting', 'etc')),
  location   text,
  memo       text,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists events_starts_idx on public.events (starts_at);

alter table public.events enable row level security;
drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (public.is_member());
drop policy if exists events_insert on public.events;
create policy events_insert on public.events for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
drop policy if exists events_update on public.events;
create policy events_update on public.events for update to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_member());
drop policy if exists events_delete on public.events;
create policy events_delete on public.events for delete to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_admin()));

-- ---------------------------------------------------------------------
-- 3. 문서: 사건 연결 · 수정본 묶음 · 양식
-- ---------------------------------------------------------------------
alter table public.documents add column if not exists case_id  uuid references public.cases (id) on delete set null;
alter table public.documents add column if not exists group_id uuid;
alter table public.documents add column if not exists version  int not null default 1;
alter table public.documents add column if not exists kind     text not null default 'file';
alter table public.documents add column if not exists form     jsonb;
update public.documents set group_id = id where group_id is null;
alter table public.documents alter column group_id set default gen_random_uuid();
alter table public.documents alter column file_path drop not null;
alter table public.documents alter column file_name drop not null;
alter table public.documents alter column file_type drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_kind_check') then
    alter table public.documents add constraint documents_kind_check check (kind in ('file', 'form'));
  end if;
end $$;
create index if not exists documents_group_idx on public.documents (group_id, version);
create index if not exists documents_case_idx on public.documents (case_id);

-- (이전 버전 화면의 create_document 로 올린 문서는 group_id 기본값으로 자기만의 묶음을 갖는다)

-- 새 등록 함수: 사건 · 수정본(p_prev_doc_id) · 양식(p_kind = 'form')
create or replace function public.create_document_v2(
  p_title text, p_description text,
  p_file_path text, p_file_name text, p_file_type text, p_file_size bigint,
  p_approvers uuid[],
  p_case_id uuid default null, p_prev_doc_id uuid default null,
  p_kind text default 'file', p_form jsonb default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_doc   uuid;
  v_n     int := coalesce(array_length(p_approvers, 1), 0);
  v_group uuid;
  v_ver   int := 1;
  prev    public.documents;
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  if p_kind not in ('file', 'form') then raise exception '잘못된 문서 종류입니다'; end if;

  if p_kind = 'file' then
    if p_file_path is null or p_file_path not like auth.uid()::text || '/%' then
      raise exception '잘못된 파일 경로입니다';
    end if;
  else
    if p_file_path is not null then raise exception '양식에는 파일을 붙일 수 없습니다'; end if;
    if coalesce(p_form ->> 'type', '') not in ('기안서', '지급품의서', '출장신청서') then
      raise exception '양식 종류가 올바르지 않습니다';
    end if;
    if p_form ->> 'type' = '지급품의서'
       and coalesce(p_form ->> 'amount', '') !~ '^[0-9]{1,12}$' then
      raise exception '지급 금액을 숫자로 입력해 주세요';
    end if;
  end if;

  if v_n <> (select count(distinct x) from unnest(p_approvers) x) then
    raise exception '컨펌자가 중복되었습니다';
  end if;
  if v_n > 0 and v_n <> (select count(*) from public.profiles where id = any (p_approvers) and active) then
    raise exception '존재하지 않거나 비활성화된 컨펌자가 있습니다';
  end if;
  if p_case_id is not null and not exists (select 1 from public.cases where id = p_case_id) then
    raise exception '사건을 찾을 수 없습니다';
  end if;

  if p_prev_doc_id is not null then
    select * into prev from public.documents where id = p_prev_doc_id;
    if not found then raise exception '이전 문서를 찾을 수 없습니다'; end if;
    v_group := coalesce(prev.group_id, prev.id);
    select coalesce(max(version), 0) + 1 into v_ver from public.documents where group_id = v_group;
  end if;

  insert into public.documents (title, description, file_path, file_name, file_type, file_size,
                                uploader_id, status, case_id, group_id, version, kind, form)
  values (trim(p_title), nullif(trim(p_description), ''), p_file_path, p_file_name, p_file_type, p_file_size,
          auth.uid(), case when v_n = 0 then 'none' else 'pending' end,
          p_case_id, coalesce(v_group, gen_random_uuid()), v_ver, p_kind, case when p_kind = 'form' then p_form end)
  returning id into v_doc;

  insert into public.approval_steps (doc_id, step_order, approver_id, state)
  select v_doc, o, a, case when o = 1 then 'current' else 'waiting' end
  from unnest(p_approvers) with ordinality as t(a, o);

  return v_doc;
end;
$$;
revoke all on function public.create_document_v2(text, text, text, text, text, bigint, uuid[], uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.create_document_v2(text, text, text, text, text, bigint, uuid[], uuid, uuid, text, jsonb) to authenticated;

-- 목록용 뷰: 컬럼 순서가 바뀌므로 지우고 다시 만든다 (기존 컬럼은 모두 유지)
drop view if exists public.document_summary;
create view public.document_summary with (security_invoker = true) as
select d.*,
       p.name as uploader_name,
       (select count(*) from public.document_views v where v.doc_id = d.id) as view_count,
       (select count(*) from public.comments c where c.doc_id = d.id) as comment_count,
       (select s.approver_id from public.approval_steps s where s.doc_id = d.id and s.state = 'current') as current_approver_id,
       c.name as case_name,
       not exists (select 1 from public.documents n where n.group_id = d.group_id and n.version > d.version) as is_latest
from public.documents d
join public.profiles p on p.id = d.uploader_id
left join public.cases c on c.id = d.case_id;
grant select on public.document_summary to authenticated;

-- 사건별 비용: 컨펌완료된 지급품의서 금액 합계 (최신본만)
create or replace view public.case_costs with (security_invoker = true) as
select d.case_id,
       sum((d.form ->> 'amount')::bigint) as approved_amount,
       count(*) as approved_count
from public.documents d
where d.kind = 'form' and d.form ->> 'type' = '지급품의서' and d.status = 'approved' and d.case_id is not null
  and not exists (select 1 from public.documents n where n.group_id = d.group_id and n.version > d.version)
group by d.case_id;
grant select on public.case_costs to authenticated;

-- ---------------------------------------------------------------------
-- 4. 실시간 반영
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['cases', 'events'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
