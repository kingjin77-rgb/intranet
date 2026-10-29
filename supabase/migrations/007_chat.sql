-- =====================================================================
-- v4.0 업데이트: 사내 메신저(채팅) · 접속 상태(관리자 확인)
--   SQL Editor 에 통째로 붙여넣고 Run (006 다음, 여러 번 실행해도 안전)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 접속 상태: 화면이 열려 있는 동안 1분마다 기록
-- ---------------------------------------------------------------------
create table if not exists public.presence (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  client       text not null default 'web' check (client in ('web', 'app', 'ext')),
  ua           text
);
alter table public.presence enable row level security;
drop policy if exists presence_read on public.presence;
create policy presence_read on public.presence for select to authenticated using (public.is_member());
revoke insert, update, delete on public.presence from anon, authenticated;

create or replace function public.touch_presence(p_client text default 'web', p_ua text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then return; end if;
  insert into public.presence (user_id, last_seen_at, client, ua)
  values (auth.uid(), now(), case when p_client in ('web', 'app', 'ext') then p_client else 'web' end, left(p_ua, 300))
  on conflict (user_id) do update
    set last_seen_at = now(), client = excluded.client, ua = excluded.ua;
end;
$$;
revoke all on function public.touch_presence(text, text) from public, anon;
grant execute on function public.touch_presence(text, text) to authenticated;

-- 관리자: 직원별 마지막 로그인 · 마지막 접속 · 사용 기기 · 알림 켠 기기 수
create or replace function public.admin_user_status()
returns table (id uuid, name text, dept text, email text, active boolean,
               last_sign_in_at timestamptz, last_seen_at timestamptz, client text, push_devices int)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자만 볼 수 있습니다'; end if;
  return query
  select p.id, p.name, p.dept, p.email, p.active,
         u.last_sign_in_at, pr.last_seen_at, pr.client,
         (case when to_regclass('public.push_subscriptions') is null then 0
               else (select count(*)::int from public.push_subscriptions s where s.user_id = p.id) end)
  from public.profiles p
  left join auth.users u on u.id = p.id
  left join public.presence pr on pr.user_id = p.id
  order by pr.last_seen_at desc nulls last, p.name;
end;
$$;
revoke all on function public.admin_user_status() from public, anon;
grant execute on function public.admin_user_status() to authenticated;

-- ---------------------------------------------------------------------
-- 2. 채팅방 · 멤버 · 메시지
--    kind: dm(1:1) · group(여럿) · all(전 직원 자동 참여)
-- ---------------------------------------------------------------------
create table if not exists public.chat_rooms (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('dm', 'group', 'all')),
  name            text,
  dm_key          text unique,          -- 1:1 방 중복 방지 (두 사람 id 정렬)
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create table if not exists public.chat_members (
  room_id      uuid not null references public.chat_rooms (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists chat_members_user_idx on public.chat_members (user_id);
create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.chat_rooms (id) on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body        text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint chat_messages_body_or_file check (length(trim(body)) > 0 or jsonb_array_length(attachments) > 0 or deleted_at is not null)
);
create index if not exists chat_messages_room_idx on public.chat_messages (room_id, created_at desc);

-- 전체방은 하나만
insert into public.chat_rooms (kind, name)
select 'all', '전체'
where not exists (select 1 from public.chat_rooms where kind = 'all');

-- 이 방에 들어갈 수 있는지 (전체방은 직원 모두)
create or replace function public.chat_can_access(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_member() and exists (
    select 1 from public.chat_rooms r where r.id = p_room
      and (r.kind = 'all' or exists (select 1 from public.chat_members m where m.room_id = r.id and m.user_id = auth.uid())));
$$;

alter table public.chat_rooms    enable row level security;
alter table public.chat_members  enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists chat_rooms_read on public.chat_rooms;
create policy chat_rooms_read on public.chat_rooms for select to authenticated using (public.chat_can_access(id));
drop policy if exists chat_rooms_update on public.chat_rooms;
create policy chat_rooms_update on public.chat_rooms for update to authenticated
  using (kind = 'group' and public.chat_can_access(id)) with check (kind = 'group');
revoke insert, delete on public.chat_rooms from anon, authenticated;

drop policy if exists chat_members_read on public.chat_members;
create policy chat_members_read on public.chat_members for select to authenticated using (public.chat_can_access(room_id));
revoke insert, update, delete on public.chat_members from anon, authenticated;

drop policy if exists chat_messages_read on public.chat_messages;
create policy chat_messages_read on public.chat_messages for select to authenticated using (public.chat_can_access(room_id));
drop policy if exists chat_messages_insert on public.chat_messages;
create policy chat_messages_insert on public.chat_messages for insert to authenticated
  with check (user_id = auth.uid() and deleted_at is null and public.chat_can_access(room_id));
-- 삭제는 지우지 않고 '삭제된 메시지'로 바꾼다 (본인만)
drop policy if exists chat_messages_update on public.chat_messages;
create policy chat_messages_update on public.chat_messages for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke delete on public.chat_messages from anon, authenticated;

-- 메시지 검사: 첨부 경로 · 개수, 수정은 '삭제 처리'만 허용
create or replace function public.chat_messages_check()
returns trigger language plpgsql as $$
declare f jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.deleted_at is null or new.room_id <> old.room_id or new.created_at <> old.created_at then
      raise exception '메시지는 삭제만 할 수 있습니다';
    end if;
    new.body := '';
    new.attachments := '[]'::jsonb;
    return new;
  end if;
  if jsonb_typeof(new.attachments) <> 'array' or jsonb_array_length(new.attachments) > 5 then
    raise exception '첨부파일은 5개까지 가능합니다';
  end if;
  for f in select * from jsonb_array_elements(new.attachments) loop
    if coalesce(f ->> 'path', '') not like new.user_id::text || '/%' or coalesce(f ->> 'name', '') = '' then
      raise exception '잘못된 첨부파일입니다';
    end if;
  end loop;
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists chat_messages_check on public.chat_messages;
create trigger chat_messages_check before insert or update on public.chat_messages
  for each row execute function public.chat_messages_check();

-- ---------------------------------------------------------------------
-- 3. 채팅 RPC
-- ---------------------------------------------------------------------
-- 1:1 방 열기 (없으면 만든다)
create or replace function public.chat_open_dm(p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_key  text;
  v_room uuid;
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  if p_user = auth.uid() then raise exception '자기 자신과는 대화할 수 없습니다'; end if;
  if not exists (select 1 from public.profiles where id = p_user and active) then raise exception '대화할 수 없는 직원입니다'; end if;
  v_key := least(auth.uid()::text, p_user::text) || ':' || greatest(auth.uid()::text, p_user::text);
  select id into v_room from public.chat_rooms where dm_key = v_key;
  if v_room is null then
    insert into public.chat_rooms (kind, dm_key, created_by) values ('dm', v_key, auth.uid())
    on conflict (dm_key) do nothing returning id into v_room;
    if v_room is null then select id into v_room from public.chat_rooms where dm_key = v_key; end if;
  end if;
  insert into public.chat_members (room_id, user_id) values (v_room, auth.uid()), (v_room, p_user)
  on conflict do nothing;
  return v_room;
end;
$$;

-- 그룹 방 만들기
create or replace function public.chat_create_group(p_name text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room uuid;
begin
  if not public.is_member() then raise exception '권한이 없습니다'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception '방 이름을 입력해 주세요'; end if;
  insert into public.chat_rooms (kind, name, created_by) values ('group', trim(p_name), auth.uid()) returning id into v_room;
  insert into public.chat_members (room_id, user_id)
  select v_room, x from (select auth.uid() as x union select unnest(p_members)) s
  join public.profiles p on p.id = s.x and p.active
  on conflict do nothing;
  return v_room;
end;
$$;

-- 그룹 방에 사람 추가 · 나가기
create or replace function public.chat_add_members(p_room uuid, p_members uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.chat_rooms r where r.id = p_room and r.kind = 'group') or not public.chat_can_access(p_room) then
    raise exception '그룹 방 멤버만 초대할 수 있습니다';
  end if;
  insert into public.chat_members (room_id, user_id)
  select p_room, p.id from public.profiles p where p.id = any (p_members) and p.active
  on conflict do nothing;
end;
$$;
create or replace function public.chat_leave(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.chat_rooms where id = p_room and kind <> 'group') then
    raise exception '그룹 방만 나갈 수 있습니다';
  end if;
  delete from public.chat_members where room_id = p_room and user_id = auth.uid();
end;
$$;

-- 읽음 표시 (전체방은 처음 읽을 때 내 행을 만든다)
create or replace function public.chat_mark_read(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.chat_can_access(p_room) then return; end if;
  insert into public.chat_members (room_id, user_id, last_read_at) values (p_room, auth.uid(), now())
  on conflict (room_id, user_id) do update set last_read_at = now();
end;
$$;

-- 방별 안 읽은 수
create or replace function public.chat_unread()
returns table (room_id uuid, unread int) language sql stable security definer set search_path = public as $$
  select r.id, (select count(*)::int from public.chat_messages m
                 where m.room_id = r.id and m.user_id <> auth.uid() and m.deleted_at is null
                   and m.created_at > coalesce(cm.last_read_at, greatest(r.created_at, pr.created_at)))
  from public.chat_rooms r
  join public.profiles pr on pr.id = auth.uid() and pr.active
  left join public.chat_members cm on cm.room_id = r.id and cm.user_id = auth.uid()
  where r.kind = 'all' or cm.user_id is not null;
$$;

do $$
declare f text;
begin
  foreach f in array array['chat_can_access(uuid)', 'chat_open_dm(uuid)', 'chat_create_group(text,uuid[])',
                           'chat_add_members(uuid,uuid[])', 'chat_leave(uuid)', 'chat_mark_read(uuid)', 'chat_unread()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. 새 메시지: 방의 최근 시각 갱신 + 휴대폰 알림 (003 의 send_push 가 있을 때만)
-- ---------------------------------------------------------------------
create or replace function public.chat_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r     public.chat_rooms;
  who   text;
  ids   uuid[];
  n     int := jsonb_array_length(coalesce(new.attachments, '[]'::jsonb));
begin
  update public.chat_rooms set last_message_at = new.created_at where id = new.room_id returning * into r;
  -- 보낸 사람은 읽은 것으로
  insert into public.chat_members (room_id, user_id, last_read_at) values (new.room_id, new.user_id, new.created_at)
  on conflict (room_id, user_id) do update set last_read_at = excluded.last_read_at;

  if to_regprocedure('public.send_push(uuid[], text, text, text)') is null then return new; end if;
  select name into who from public.profiles where id = new.user_id;
  if r.kind = 'all' then
    select array_agg(id) into ids from public.profiles where active and id <> new.user_id;
  else
    select array_agg(m.user_id) into ids from public.chat_members m
      join public.profiles p on p.id = m.user_id and p.active
     where m.room_id = new.room_id and m.user_id <> new.user_id;
  end if;
  execute 'select public.send_push($1, $2, $3, $4)' using ids,
    '💬 ' || coalesce(who, '') || case when r.kind = 'dm' then '' else ' (' || coalesce(r.name, '') || ')' end,
    concat_ws(' ', nullif(left(trim(new.body), 80), ''), case when n > 0 then '📎 첨부 ' || n || '개' end),
    'chat.html#' || new.room_id;
  return new;
end;
$$;
drop trigger if exists chat_on_message on public.chat_messages;
create trigger chat_on_message after insert on public.chat_messages
  for each row execute function public.chat_on_message();

-- ---------------------------------------------------------------------
-- 5. 실시간 반영
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['chat_messages', 'chat_members', 'chat_rooms', 'presence'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
