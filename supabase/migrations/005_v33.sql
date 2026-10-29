-- =====================================================================
-- v3.3 업데이트: 코멘트 첨부파일 · 이모지 반응 · 컨펌 동시 요청(수평)
--   SQL Editor 에 통째로 붙여넣고 Run (002 → 003 → 004 다음, 여러 번 실행해도 안전)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 컨펌을 동시에: 지정한 컨펌자 모두에게 한꺼번에 차례가 간다.
--    전원 컨펌 → 최종 컨펌완료, 한 명이라도 반려 → 반려.
--    이미 진행 중인 예전(순서대로) 문서는 남은 사람에게 차례대로 넘어간다.
-- ---------------------------------------------------------------------

-- 이전 버전 화면이 쓰는 등록 함수도 동시 요청으로
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
  select v_doc, o, a, 'current'
  from unnest(p_approvers) with ordinality as t(a, o);

  return v_doc;
end;
$$;


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
  select v_doc, o, a, 'current'
  from unnest(p_approvers) with ordinality as t(a, o);

  return v_doc;
end;
$$;
revoke all on function public.create_document_v2(text, text, text, text, text, bigint, uuid[], uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.create_document_v2(text, text, text, text, text, bigint, uuid[], uuid, uuid, text, jsonb) to authenticated;

create or replace function public.act_on_step(p_step_id uuid, p_decision text, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.approval_steps;
begin
  if p_decision not in ('approved', 'rejected') then raise exception '잘못된 컨펌 값입니다'; end if;
  if p_decision = 'rejected' and coalesce(trim(p_comment), '') = '' then
    raise exception '반려 사유를 입력해 주세요';
  end if;

  -- 동시 컨펌이 겹쳐도 한 문서씩 처리되도록 문서 행을 잠근다
  perform 1 from public.documents d join public.approval_steps x on x.doc_id = d.id where x.id = p_step_id for update of d;
  select * into s from public.approval_steps where id = p_step_id for update;
  if not found then raise exception '컨펌 단계를 찾을 수 없습니다'; end if;
  if s.approver_id <> auth.uid() or not public.is_member() then raise exception '본인 컨펌 차례가 아닙니다'; end if;
  if s.state <> 'current' then raise exception '이미 처리되었거나 아직 차례가 아닙니다'; end if;

  update public.approval_steps
     set state = p_decision, comment = nullif(trim(p_comment), ''), acted_at = now()
   where id = s.id;

  if p_decision = 'rejected' then
    update public.approval_steps set state = 'skipped' where doc_id = s.doc_id and state in ('waiting', 'current');
    update public.documents set status = 'rejected' where id = s.doc_id;
  elsif exists (select 1 from public.approval_steps where doc_id = s.doc_id and state = 'current') then
    null; -- 다른 컨펌자를 기다린다
  elsif exists (select 1 from public.approval_steps where doc_id = s.doc_id and state = 'waiting') then
    update public.approval_steps set state = 'current'
     where doc_id = s.doc_id
       and step_order = (select min(step_order) from public.approval_steps where doc_id = s.doc_id and state = 'waiting');
  else
    update public.documents set status = 'approved' where id = s.doc_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. 코멘트 첨부파일 (최대 5개, 파일은 docs 버킷의 본인 폴더)
-- ---------------------------------------------------------------------
alter table public.comments add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.comments drop constraint if exists comments_body_check;
alter table public.comments drop constraint if exists comments_body_or_file;
alter table public.comments add constraint comments_body_or_file
  check (length(trim(body)) > 0 or jsonb_array_length(attachments) > 0);

create or replace function public.comments_check_files()
returns trigger language plpgsql as $$
declare f jsonb;
begin
  if jsonb_typeof(new.attachments) <> 'array' or jsonb_array_length(new.attachments) > 5 then
    raise exception '첨부파일은 5개까지 가능합니다';
  end if;
  for f in select * from jsonb_array_elements(new.attachments) loop
    if coalesce(f ->> 'path', '') not like new.user_id::text || '/%' or coalesce(f ->> 'name', '') = '' then
      raise exception '잘못된 첨부파일입니다';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists comments_check_files on public.comments;
create trigger comments_check_files before insert or update of attachments on public.comments
  for each row execute function public.comments_check_files();

-- ---------------------------------------------------------------------
-- 3. 코멘트 반응 (❤️ 👍 등)
-- ---------------------------------------------------------------------
create table if not exists public.comment_reactions (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji      text not null check (emoji in ('❤️', '👍', '😂', '😮', '🙏', '🔥', '👀', '✅')),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id, emoji)
);
alter table public.comment_reactions enable row level security;
drop policy if exists reactions_read on public.comment_reactions;
create policy reactions_read on public.comment_reactions for select to authenticated using (public.is_member());
drop policy if exists reactions_insert on public.comment_reactions;
create policy reactions_insert on public.comment_reactions for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
drop policy if exists reactions_delete on public.comment_reactions;
create policy reactions_delete on public.comment_reactions for delete to authenticated
  using (user_id = auth.uid());

do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comment_reactions') then
    alter publication supabase_realtime add table public.comment_reactions;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. 알림 (003 의 send_push 가 있을 때만)
-- ---------------------------------------------------------------------
do $do$ begin
  if to_regprocedure('public.send_push(uuid[], text, text, text)') is null then
    raise notice '003_v3.sql 을 실행하지 않아 휴대폰 알림 부분은 건너뜁니다';
    return;
  end if;

  -- 코멘트: 글 없이 첨부만 있으면 "📎 첨부 n개"
  create or replace function public.push_on_comment()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    d   public.documents;
    who text;
    ids uuid[];
    n   int := jsonb_array_length(coalesce(new.attachments, '[]'::jsonb));
  begin
    select * into d from public.documents where id = new.doc_id;
    select name into who from public.profiles where id = new.user_id;
    select array_agg(distinct u) into ids from (
      select d.uploader_id as u
      -- 수정본(v1·v2…)은 코멘트가 이어지므로, 같은 묶음 문서의 참여자 모두에게
      union select c.user_id from public.comments c join public.documents g on g.id = c.doc_id
             where g.group_id = d.group_id or c.doc_id = new.doc_id
      union select s.approver_id from public.approval_steps s join public.documents g on g.id = s.doc_id
             where g.group_id = d.group_id or s.doc_id = new.doc_id
    ) x
    join public.profiles p on p.id = x.u and p.active
    where x.u <> new.user_id;
    perform public.send_push(ids, '💬 ' || coalesce(who, '') || ': ' || coalesce(d.title, ''),
      concat_ws(' ', nullif(left(trim(new.body), 80), ''), case when n > 0 then '📎 첨부 ' || n || '개' end),
      'doc.html?id=' || new.doc_id);
    return new;
  end;
  $$;
  drop trigger if exists push_on_comment on public.comments;
  create trigger push_on_comment after insert on public.comments
    for each row execute function public.push_on_comment();

  -- 반응: 코멘트 쓴 사람에게
  create or replace function public.push_on_reaction()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    c   public.comments;
    who text;
  begin
    select * into c from public.comments where id = new.comment_id;
    if c.user_id is null or c.user_id = new.user_id then return new; end if;
    select name into who from public.profiles where id = new.user_id;
    perform public.send_push(array[c.user_id], new.emoji || ' ' || coalesce(who, '') || '님이 내 코멘트에 반응',
      left(coalesce(nullif(trim(c.body), ''), '📎 첨부'), 80), 'doc.html?id=' || c.doc_id);
    return new;
  end;
  $$;
  drop trigger if exists push_on_reaction on public.comment_reactions;
  create trigger push_on_reaction after insert on public.comment_reactions
    for each row execute function public.push_on_reaction();

  -- 컨펌 결과: 다른 컨펌자가 아직 남아 있으면 "OOO님 컨펌", 모두 끝나면 "최종 컨펌완료"
  create or replace function public.push_on_step_result()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    d     public.documents;
    who   text;
    final boolean;
  begin
    if new.state not in ('approved', 'rejected') or old.state is not distinct from new.state then return new; end if;
    select * into d from public.documents where id = new.doc_id;
    if d.uploader_id = new.approver_id then return new; end if;
    select name into who from public.profiles where id = new.approver_id;
    final := not exists (select 1 from public.approval_steps
                          where doc_id = new.doc_id and id <> new.id and state in ('waiting', 'current'));
    perform public.send_push(array[d.uploader_id],
      case when new.state = 'rejected' then '↩️ 반려: ' || d.title
           when final then '🎉 최종 컨펌완료: ' || d.title
           else '✅ ' || coalesce(who, '') || '님 컨펌: ' || d.title end,
      concat_ws(' · ', who, nullif(left(coalesce(new.comment, ''), 60), '')),
      'doc.html?id=' || new.doc_id);
    return new;
  end;
  $$;
  drop trigger if exists push_on_step_result on public.approval_steps;
  create trigger push_on_step_result after update of state on public.approval_steps
    for each row execute function public.push_on_step_result();
end $do$;

-- ---------------------------------------------------------------------
-- 5. 이미 올린 문서에 컨펌자 추가 (컨펌자 없이 올렸거나, 한 명 더 받을 때)
--    올린 사람·관리자만, 공유(none)·컨펌중(pending) 문서만. 추가된 사람에게 바로 차례가 간다.
-- ---------------------------------------------------------------------
create or replace function public.add_approvers(p_doc_id uuid, p_approvers uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare
  d     public.documents;
  v_max int;
  v_n   int;
begin
  select * into d from public.documents where id = p_doc_id for update;
  if not found then raise exception '문서를 찾을 수 없습니다'; end if;
  if not public.is_member() or (d.uploader_id <> auth.uid() and not public.is_admin()) then
    raise exception '올린 사람이나 관리자만 컨펌자를 추가할 수 있습니다';
  end if;
  if d.status not in ('none', 'pending') then
    raise exception '이미 컨펌이 끝났거나 반려된 문서입니다. 수정본으로 다시 요청하세요';
  end if;
  if coalesce(array_length(p_approvers, 1), 0) = 0 then raise exception '컨펌자를 골라 주세요'; end if;
  if exists (select 1 from unnest(p_approvers) a where not exists
              (select 1 from public.profiles p where p.id = a and p.active)) then
    raise exception '존재하지 않거나 비활성화된 컨펌자가 있습니다';
  end if;

  select coalesce(max(step_order), 0) into v_max from public.approval_steps where doc_id = p_doc_id;
  insert into public.approval_steps (doc_id, step_order, approver_id, state)
  select p_doc_id, v_max + row_number() over (), a, 'current'
  from (select distinct a from unnest(p_approvers) a) x
  where not exists (select 1 from public.approval_steps s where s.doc_id = p_doc_id and s.approver_id = x.a);
  get diagnostics v_n = row_count;

  if v_n > 0 and d.status = 'none' then
    update public.documents set status = 'pending' where id = p_doc_id;
  end if;
  return v_n;
end;
$$;
revoke all on function public.add_approvers(uuid, uuid[]) from public, anon;
grant execute on function public.add_approvers(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 6. 목록 뷰: 동시 컨펌이면 '컨펌 차례'가 여러 명이라, 한 명만 고르도록 다시 만든다
--    (보는 사람이 그중 하나면 본인을, 아니면 아무나 한 명) — 기존 화면의 '내 차례' 표시 그대로 동작
-- ---------------------------------------------------------------------
create or replace view public.document_summary with (security_invoker = true) as
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
