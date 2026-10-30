-- =====================================================================
-- v6 업데이트: 문서 위 첨삭(펜·형광펜·밑줄·메모·도장) · 고침 체크 · 개인 아바타
--   SQL Editor 에 통째로 붙여넣고 Run (008 다음, 여러 번 실행해도 안전)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 첨삭
--    좌표는 페이지 크기 기준 0~1 비율 (화면 크기가 달라도 같은 자리)
--    kind: pen(자유선) · highlight(형광펜) · underline(밑줄) · note(메모)
--          stamp(도장) · check(수정본 비교에서 '확인' 체크)
-- ---------------------------------------------------------------------
create table if not exists public.doc_annotations (
  id         uuid primary key default gen_random_uuid(),
  doc_id     uuid not null references public.documents (id) on delete cascade,
  file_path  text not null default '',
  page       int  not null default 1 check (page >= 1),
  kind       text not null check (kind in ('pen', 'highlight', 'underline', 'note', 'stamp', 'check')),
  data       jsonb not null default '{}' check (pg_column_size(data) < 65536),
  color      text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  body       text check (body is null or length(body) <= 1000),
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  checked_at timestamptz,
  checked_by uuid references public.profiles (id) on delete set null
);
create index if not exists doc_annotations_doc on public.doc_annotations (doc_id, created_at);

alter table public.doc_annotations enable row level security;
drop policy if exists ann_read on public.doc_annotations;
create policy ann_read on public.doc_annotations for select to authenticated using (public.is_member());
drop policy if exists ann_insert on public.doc_annotations;
create policy ann_insert on public.doc_annotations for insert to authenticated
  with check (public.is_member() and user_id = auth.uid() and checked_at is null and checked_by is null);
drop policy if exists ann_update on public.doc_annotations;
create policy ann_update on public.doc_annotations for update to authenticated
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());
drop policy if exists ann_delete on public.doc_annotations;
create policy ann_delete on public.doc_annotations for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- 체크 표시는 아래 RPC로만 (작성자가 아닌 '올린 사람'도 체크할 수 있게)
revoke update on public.doc_annotations from authenticated;
grant update (data, color, body) on public.doc_annotations to authenticated;

create or replace function public.toggle_annotation_check(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  a public.doc_annotations;
  owner uuid;
begin
  select * into a from public.doc_annotations where id = p_id for update;
  if not found then raise exception '첨삭을 찾을 수 없습니다'; end if;
  select uploader_id into owner from public.documents where id = a.doc_id;
  if not public.is_member() or not (auth.uid() in (a.user_id, owner) or public.is_admin()) then
    raise exception '올린 사람이나 첨삭한 사람만 체크할 수 있습니다';
  end if;
  update public.doc_annotations
     set checked_at = case when checked_at is null then now() end,
         checked_by = case when checked_at is null then auth.uid() end
   where id = p_id;
  return a.checked_at is null;
end;
$$;
revoke all on function public.toggle_annotation_check(uuid) from public, anon;
grant execute on function public.toggle_annotation_check(uuid) to authenticated;

-- 첨삭 알림: 올린 사람에게, 같은 사람이 10분 안에 또 첨삭하면 보내지 않음 (획마다 알림 방지)
create or replace function public.push_on_annotation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  d   public.documents;
  who text;
begin
  if new.kind = 'check' then return new; end if;
  select * into d from public.documents where id = new.doc_id;
  if d.uploader_id = new.user_id then return new; end if;
  if exists (select 1 from public.doc_annotations
              where doc_id = new.doc_id and user_id = new.user_id and id <> new.id
                and kind <> 'check' and created_at > now() - interval '10 minutes') then
    return new;
  end if;
  select name into who from public.profiles where id = new.user_id;
  perform public.notify_users(array[d.uploader_id], '🖍 ' || coalesce(who, '') || '님이 첨삭했습니다',
    d.title || coalesce(' · ' || left(new.body, 60), ''), 'doc.html?id=' || d.id);
  return new;
end;
$$;
drop trigger if exists push_on_annotation on public.doc_annotations;
create trigger push_on_annotation after insert on public.doc_annotations
  for each row execute function public.push_on_annotation();

do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'doc_annotations') then
    alter publication supabase_realtime add table public.doc_annotations;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. 개인 아바타
--    'char:fox' 같은 캐릭터 이름, 또는 'img:<본인uid>/avatar-….jpg' (비공개 docs 버킷)
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists avatar text;

create or replace function public.set_avatar(p text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception '로그인이 필요합니다'; end if;
  if p is not null and not (
       p ~ '^char:[a-z]{2,12}$'
       or p ~ ('^img:' || auth.uid()::text || '/avatar-[A-Za-z0-9_-]{4,40}\.(jpg|png|webp)$')) then
    raise exception '아바타 형식이 올바르지 않습니다';
  end if;
  update public.profiles set avatar = p where id = auth.uid();
end;
$$;
revoke all on function public.set_avatar(text) from public, anon;
grant execute on function public.set_avatar(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. 호칭: 변호사님은 'OOO 변호사님', 나머지는 'OOO님'
--    직함은 직원관리에서 바꿀 수 있고, 처음엔 이지훈·하혜용 두 분을 변호사로
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists title text check (title is null or length(title) <= 20);
update public.profiles set title = '변호사' where name in ('이지훈', '하혜용') and title is null;

create or replace function public.honor(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(name, '') || case when coalesce(title, '') <> '' then ' ' || title || '님' else '님' end
  from public.profiles where id = p_id;
$$;
revoke all on function public.honor(uuid) from public, anon, authenticated;

create or replace function public.admin_set_title(p_id uuid, p_title text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자만 직함을 바꿀 수 있습니다'; end if;
  update public.profiles set title = nullif(trim(p_title), '') where id = p_id;
end;
$$;
revoke all on function public.admin_set_title(uuid, text) from public, anon;
grant execute on function public.admin_set_title(uuid, text) to authenticated;

-- 컨펌 차례 알림: 변호사님께는 "검토 부탁드립니다"
do $do$ begin
  if to_regprocedure('public.send_push(uuid[], text, text, text)') is null then return; end if;
  create or replace function public.push_on_step()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    d  public.documents;
    tt text;
  begin
    if new.state = 'current' and (tg_op = 'INSERT' or old.state is distinct from 'current') then
      select * into d from public.documents where id = new.doc_id;
      select title into tt from public.profiles where id = new.approver_id;
      perform public.send_push(array[new.approver_id],
        case when tt = '변호사' then '⚖️ ' || public.honor(new.approver_id) || ', 검토 부탁드립니다'
             else '✍️ ' || public.honor(new.approver_id) || ', 컨펌 부탁드립니다' end,
        coalesce(d.title, '') || coalesce(' · ' || public.honor(d.uploader_id) || ' 요청', ''),
        'doc.html?id=' || new.doc_id);
    end if;
    return new;
  end;
  $$;
end $do$;

-- '컨펌 요청 다시 보내기'도 사람마다 호칭을 붙여서
do $do$ begin
  if to_regprocedure('public.notify_users(uuid[], text, text, text)') is null then return; end if;
  create or replace function public.nudge_doc(p_doc uuid, p_kind text)
  returns int language plpgsql security definer set search_path = public as $$
  declare
    d   public.documents;
    ids uuid[];
    u   uuid;
  begin
    select * into d from public.documents where id = p_doc for update;
    if not found or (d.uploader_id <> auth.uid() and not public.is_admin()) then
      raise exception '올린 사람이나 관리자만 요청할 수 있습니다';
    end if;
    if d.nudged_at > now() - interval '10 minutes' then
      raise exception '방금 요청했습니다. 10분 뒤에 다시 보낼 수 있습니다';
    end if;
    if p_kind = 'approvers' then
      select array_agg(approver_id) into ids from public.approval_steps where doc_id = p_doc and state = 'current';
      foreach u in array coalesce(ids, '{}') loop
        perform public.notify_users(array[u],
          case when (select title from public.profiles where id = u) = '변호사'
               then '⚖️ ' || public.honor(u) || ', 검토 부탁드립니다' else '⏰ ' || public.honor(u) || ', 컨펌 부탁드립니다' end,
          d.title || ' · ' || coalesce(public.honor(auth.uid()), '') || '이 기다리고 있습니다' || coalesce(' · 기한 ' || to_char(d.due_date, 'MM/DD'), ''),
          'doc.html?id=' || p_doc);
      end loop;
    else
      select array_agg(p.id) into ids from public.profiles p
       where p.active and p.id <> d.uploader_id
         and not exists (select 1 from public.document_views v where v.doc_id = p_doc and v.user_id = p.id);
      foreach u in array coalesce(ids, '{}') loop
        perform public.notify_users(array[u], '👀 ' || public.honor(u) || ', 확인 부탁드립니다',
          d.title || ' · ' || coalesce(public.honor(auth.uid()), '') || '의 요청', 'doc.html?id=' || p_doc);
      end loop;
    end if;
    update public.documents set nudged_at = now() where id = p_doc;
    return coalesce(array_length(ids, 1), 0);
  end;
  $$;
end $do$;
