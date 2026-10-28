-- =====================================================================
-- v3.1 알림 보강: 새 문서 · 코멘트 · 열람 확인 · 컨펌 결과도 휴대폰 알림
--   003_v3.sql 을 먼저 실행한 뒤, SQL Editor 에 통째로 붙여넣고 Run
--   (여러 번 실행해도 안전, 추가만 함)
--   휴대폰 알림은 push_config(보내는 함수 주소)가 설정된 경우에만 실제로 나간다.
-- =====================================================================

do $$ begin
  if to_regprocedure('public.send_push(uuid[], text, text, text)') is null then
    raise exception '003_v3.sql 을 먼저 실행해 주세요';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. 새 문서 → 전 직원 (올린 사람·지금 컨펌 차례인 사람 제외)
--    커밋 시점에 실행해서, 컨펌 차례인 사람은 "컨펌 차례" 알림 하나만 받게 한다.
-- ---------------------------------------------------------------------
create or replace function public.push_on_document()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who  text;
  cname text;
  ids  uuid[];
begin
  select name into who from public.profiles where id = new.uploader_id;
  select name into cname from public.cases where id = new.case_id;
  select array_agg(p.id) into ids
  from public.profiles p
  where p.active and p.id <> new.uploader_id
    and not exists (select 1 from public.approval_steps s
                     where s.doc_id = new.id and s.approver_id = p.id and s.state = 'current');
  perform public.send_push(ids,
    case when new.version > 1 then '📄 수정본(v' || new.version || '): ' else '📄 새 문서: ' end || new.title,
    concat_ws(' · ', who, cname),
    'doc.html?id=' || new.id);
  return null;
end;
$$;
drop trigger if exists push_on_document on public.documents;
create constraint trigger push_on_document after insert on public.documents
  deferrable initially deferred
  for each row execute function public.push_on_document();

-- ---------------------------------------------------------------------
-- 2. 코멘트 → 올린 사람 + 이 문서에 코멘트 단 사람 + 컨펌자 (쓴 사람 제외)
-- ---------------------------------------------------------------------
create or replace function public.push_on_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  d   public.documents;
  who text;
  ids uuid[];
begin
  select * into d from public.documents where id = new.doc_id;
  select name into who from public.profiles where id = new.user_id;
  select array_agg(distinct u) into ids from (
    select d.uploader_id as u
    union select user_id from public.comments where doc_id = new.doc_id
    union select approver_id from public.approval_steps where doc_id = new.doc_id
  ) x
  join public.profiles p on p.id = x.u and p.active
  where x.u <> new.user_id;
  perform public.send_push(ids, '💬 ' || coalesce(who, '') || ': ' || coalesce(d.title, ''),
    left(new.body, 80), 'doc.html?id=' || new.doc_id);
  return new;
end;
$$;
drop trigger if exists push_on_comment on public.comments;
create trigger push_on_comment after insert on public.comments
  for each row execute function public.push_on_comment();

-- ---------------------------------------------------------------------
-- 3. 처음 열람 → 올린 사람 ("OOO님이 확인했습니다 · 3/12명")
--    같은 사람이 다시 열면 알리지 않는다 (insert 는 처음 한 번뿐).
-- ---------------------------------------------------------------------
create or replace function public.push_on_view()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  d     public.documents;
  who   text;
  seen  int;
  total int;
begin
  select * into d from public.documents where id = new.doc_id;
  if d.uploader_id is null or d.uploader_id = new.user_id then return new; end if;
  select name into who from public.profiles where id = new.user_id;
  select count(*) into seen from public.document_views where doc_id = new.doc_id and user_id <> d.uploader_id;
  select count(*) into total from public.profiles where active and id <> d.uploader_id;
  perform public.send_push(array[d.uploader_id], '👀 ' || coalesce(who, '') || '님이 확인했습니다',
    d.title || ' · ' || seen || '/' || total || '명 확인', 'doc.html?id=' || new.doc_id);
  return new;
end;
$$;
drop trigger if exists push_on_view on public.document_views;
create trigger push_on_view after insert on public.document_views
  for each row execute function public.push_on_view();

-- ---------------------------------------------------------------------
-- 4. 컨펌·반려 → 올린 사람
-- ---------------------------------------------------------------------
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
  -- act_on_step 은 이 단계를 바꾼 뒤에 다음 단계를 current 로 올리므로, 지금 waiting 이 없으면 마지막 단계
  final := not exists (select 1 from public.approval_steps where doc_id = new.doc_id and state = 'waiting');
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
