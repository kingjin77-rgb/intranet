-- =====================================================================
-- v3.5 업데이트: 문서 1건에 파일 여러 개 (대표 파일 + 추가 파일)
--   SQL Editor 에 통째로 붙여넣고 Run (005 다음, 여러 번 실행해도 안전)
--   첫 파일은 지금처럼 file_path 에, 나머지는 extra_files 에 들어가므로 예전 화면도 대표 파일은 보인다.
-- =====================================================================

alter table public.documents add column if not exists extra_files jsonb not null default '[]'::jsonb;

create or replace function public.documents_check_files()
returns trigger language plpgsql as $$
declare f jsonb;
begin
  if jsonb_typeof(new.extra_files) <> 'array' or jsonb_array_length(new.extra_files) > 9 then
    raise exception '파일은 한 문서에 10개까지 올릴 수 있습니다';
  end if;
  for f in select * from jsonb_array_elements(new.extra_files) loop
    if coalesce(f ->> 'path', '') not like new.uploader_id::text || '/%' or coalesce(f ->> 'name', '') = '' then
      raise exception '잘못된 첨부 파일입니다';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists documents_check_files on public.documents;
create trigger documents_check_files before insert or update of extra_files on public.documents
  for each row execute function public.documents_check_files();

-- 여러 파일 등록: create_document_v2 로 만든 뒤 추가 파일을 붙인다
create or replace function public.create_document_v3(
  p_title text, p_description text,
  p_file_path text, p_file_name text, p_file_type text, p_file_size bigint,
  p_approvers uuid[],
  p_case_id uuid default null, p_prev_doc_id uuid default null,
  p_extra_files jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_doc uuid;
begin
  v_doc := public.create_document_v2(p_title, p_description, p_file_path, p_file_name, p_file_type, p_file_size,
                                     p_approvers, p_case_id, p_prev_doc_id, 'file', null);
  update public.documents set extra_files = coalesce(p_extra_files, '[]'::jsonb) where id = v_doc;
  return v_doc;
end;
$$;
revoke all on function public.create_document_v3(text, text, text, text, text, bigint, uuid[], uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_document_v3(text, text, text, text, text, bigint, uuid[], uuid, uuid, jsonb) to authenticated;

-- 목록 뷰에 새 컬럼(extra_files)을 넣으려면 지우고 다시 만들어야 한다
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
