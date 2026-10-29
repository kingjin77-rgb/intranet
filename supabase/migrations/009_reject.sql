-- =====================================================================
-- v5.1 업데이트: 반려는 '그 사람만' — 한 명이 반려해도 문서는 계속 컨펌중
--   · 반려한 사람 줄에만 반려 표시, 나머지 컨펌자는 그대로 컨펌
--   · 모두 처리하면: 컨펌이 1명이라도 있으면 '컨펌완료', 전원 반려면 '반려'
--   · 반려가 있어도(반려된 문서도) 컨펌자 추가 가능
--   SQL Editor 에 통째로 붙여넣고 Run (005 다음 아무 때나, 여러 번 실행해도 안전)
-- =====================================================================

-- 남은 차례가 없으면 최종 상태를 정한다 (컨펌 1명 이상 → 완료, 아니면 반려)
create or replace function public.settle_document(p_doc uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_next int;
begin
  if exists (select 1 from public.approval_steps where doc_id = p_doc and state = 'current') then
    update public.documents set status = 'pending' where id = p_doc and status <> 'pending';
    return;
  end if;
  -- 예전 방식(순서대로) 문서: 다음 사람에게 차례를 넘긴다
  select min(step_order) into v_next from public.approval_steps where doc_id = p_doc and state = 'waiting';
  if v_next is not null then
    update public.approval_steps set state = 'current' where doc_id = p_doc and step_order = v_next;
    update public.documents set status = 'pending' where id = p_doc and status <> 'pending';
    return;
  end if;
  update public.documents
     set status = case when exists (select 1 from public.approval_steps where doc_id = p_doc and state = 'approved')
                       then 'approved' else 'rejected' end
   where id = p_doc;
end;
$$;
revoke all on function public.settle_document(uuid) from public, anon, authenticated;

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
  perform public.settle_document(s.doc_id);
end;
$$;

-- 컨펌자 추가: 반려된 문서도 가능 (추가하면 다시 컨펌중)
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
  if d.status = 'approved' then
    raise exception '이미 컨펌이 끝난 문서입니다. 수정본으로 다시 요청하세요';
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

  if v_n > 0 then
    update public.documents set status = 'pending' where id = p_doc_id and status <> 'pending';
  end if;
  return v_n;
end;
$$;
revoke all on function public.add_approvers(uuid, uuid[]) from public, anon;
grant execute on function public.add_approvers(uuid, uuid[]) to authenticated;

-- 알림 문구: 반려해도 다른 사람이 남아 있으면 'OOO님 반려', 모두 끝나면 최종 결과
do $do$ begin
  if to_regprocedure('public.send_push(uuid[], text, text, text)') is null then return; end if;
  create or replace function public.push_on_step_result()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    d       public.documents;
    who     text;
    final   boolean;
    any_ok  boolean;
  begin
    if new.state not in ('approved', 'rejected') or old.state is not distinct from new.state then return new; end if;
    select * into d from public.documents where id = new.doc_id;
    if d.uploader_id = new.approver_id then return new; end if;
    select name into who from public.profiles where id = new.approver_id;
    final := not exists (select 1 from public.approval_steps
                          where doc_id = new.doc_id and id <> new.id and state in ('waiting', 'current'));
    any_ok := new.state = 'approved' or exists (select 1 from public.approval_steps
                          where doc_id = new.doc_id and id <> new.id and state = 'approved');
    perform public.send_push(array[d.uploader_id],
      case when final and any_ok then '🎉 최종 컨펌완료: '
           when final then '↩️ 반려: '
           when new.state = 'rejected' then '↩️ ' || coalesce(who, '') || '님 반려: '
           else '✅ ' || coalesce(who, '') || '님 컨펌: ' end || d.title,
      concat_ws(' · ', who, nullif(left(coalesce(new.comment, ''), 60), '')),
      'doc.html?id=' || new.doc_id);
    return new;
  end;
  $$;
end $do$;

-- 예전 규칙으로 '한 명 반려 → 문서 전체 반려'가 된 최신 문서는 되살린다:
-- 반려 때문에 건너뛴(skipped) 다른 컨펌자에게 다시 차례를 주고 컨펌중으로
update public.approval_steps s set state = 'current'
  from public.documents d
 where s.doc_id = d.id and s.state = 'skipped' and d.status = 'rejected'
   and not exists (select 1 from public.documents n where n.group_id = d.group_id and n.version > d.version);
update public.documents d set status = 'pending'
 where d.status = 'rejected'
   and exists (select 1 from public.approval_steps s where s.doc_id = d.id and s.state = 'current');
