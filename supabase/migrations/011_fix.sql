-- =====================================================================
-- v6.2 업데이트: 문서 위 '고쳐쓰기'(취소선 + 고칠 문구) · 첨삭 답글(함께 보완)
--   SQL Editor 에 통째로 붙여넣고 Run (010 다음, 여러 번 실행해도 안전)
-- =====================================================================

-- 1. 첨삭 종류에 '고쳐쓰기(fix)' 추가: data = {x,y,w,h, orig(원래 글자)}, body = 고칠 문구
alter table public.doc_annotations drop constraint if exists doc_annotations_kind_check;
alter table public.doc_annotations add constraint doc_annotations_kind_check
  check (kind in ('pen', 'highlight', 'underline', 'note', 'stamp', 'check', 'fix'));

-- 2. 첨삭 답글: 메모·고쳐쓰기·밑줄·도장마다 의견을 이어서 달 수 있다
create table if not exists public.annotation_replies (
  id         uuid primary key default gen_random_uuid(),
  ann_id     uuid not null references public.doc_annotations (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body       text not null check (length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists annotation_replies_ann on public.annotation_replies (ann_id, created_at);

alter table public.annotation_replies enable row level security;
drop policy if exists annrep_read on public.annotation_replies;
create policy annrep_read on public.annotation_replies for select to authenticated using (public.is_member());
drop policy if exists annrep_insert on public.annotation_replies;
create policy annrep_insert on public.annotation_replies for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
drop policy if exists annrep_delete on public.annotation_replies;
create policy annrep_delete on public.annotation_replies for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
revoke update on public.annotation_replies from authenticated;

-- 답글 알림: 첨삭한 사람 + 문서 올린 사람 (답글 쓴 본인 제외)
create or replace function public.push_on_ann_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a   public.doc_annotations;
  d   public.documents;
  ids uuid[];
begin
  select * into a from public.doc_annotations where id = new.ann_id;
  select * into d from public.documents where id = a.doc_id;
  select array_agg(distinct u) into ids from unnest(array[a.user_id, d.uploader_id]) u where u is not null and u <> new.user_id;
  perform public.notify_users(ids,
    '💬 ' || coalesce(public.honor(new.user_id), '') || '이 ' || case when a.kind = 'fix' then '수정 의견' else '첨삭' end || '에 답글',
    d.title || ' · ' || left(new.body, 60), 'doc.html?id=' || d.id);
  return new;
end;
$$;
drop trigger if exists push_on_ann_reply on public.annotation_replies;
create trigger push_on_ann_reply after insert on public.annotation_replies
  for each row execute function public.push_on_ann_reply();

do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'annotation_replies') then
    alter publication supabase_realtime add table public.annotation_replies;
  end if;
end $$;

-- 3. 첨삭 알림에도 호칭 (이지훈 변호사님이 첨삭했습니다)
create or replace function public.push_on_annotation()
returns trigger language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  if new.kind = 'check' then return new; end if;
  select * into d from public.documents where id = new.doc_id;
  if d.uploader_id = new.user_id then return new; end if;
  if exists (select 1 from public.doc_annotations
              where doc_id = new.doc_id and user_id = new.user_id and id <> new.id
                and kind <> 'check' and created_at > now() - interval '10 minutes') then
    return new;
  end if;
  perform public.notify_users(array[d.uploader_id],
    case when new.kind = 'fix' then '✍️ ' else '🖍 ' end || coalesce(public.honor(new.user_id), '') || '이 ' ||
    case when new.kind = 'fix' then '고칠 곳을 표시했습니다' else '첨삭했습니다' end,
    d.title || coalesce(' · ' || left(new.body, 60), ''), 'doc.html?id=' || d.id);
  return new;
end;
$$;
