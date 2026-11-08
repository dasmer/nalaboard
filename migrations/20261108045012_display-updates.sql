-- One transactional revision makes polling cheap and prevents commit-order gaps.
create table public.nb_board_revision(singleton boolean primary key default true check(singleton), revision bigint not null default 0);
insert into public.nb_board_revision values(true,0);
alter table public.nb_board_revision enable row level security;
revoke all on public.nb_board_revision from public,anon,authenticated;
grant all on public.nb_board_revision to project_admin;
alter table public.nb_matches add column display_sequence bigint;
create unique index nb_matches_display_sequence on public.nb_matches(display_sequence) where display_sequence is not null;
create function public.nb_board_changed() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare seq bigint;
begin
 update public.nb_board_revision set revision=revision+1 where singleton returning revision into seq;
 if tg_table_name='nb_matches' and tg_op='INSERT' then new.display_sequence:=seq; end if;
 return new;
end $$;
create trigger nb_match_board_changed before insert or update on public.nb_matches for each row execute function public.nb_board_changed();
create trigger nb_player_board_changed after insert or update or delete on public.nb_players for each row execute function public.nb_board_changed();
revoke all on function public.nb_board_changed() from public,anon,authenticated;
grant execute on function public.nb_board_changed() to project_admin;
create function public.nb_display_state(p_token text,p_version text default null,p_cursor bigint default null) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare d public.nb_displays; rev bigint; v text; events jsonb; snapshot jsonb; next_cursor bigint;
 today date:=(now() at time zone 'Europe/London')::date;
begin
 select * into d from public.nb_displays where token_hash=p_token;
 if not found or d.revoked_at is not null or d.last_seen_at<=now()-interval '90 days' then
  return jsonb_build_object('error','Activate this display again.','status',401);
 end if;
 if d.activated_at is null then
  return jsonb_build_object('active',false,'expiresAt',d.pairing_expires_at);
 end if;
 if d.last_seen_at<now()-interval '1 hour' then
  update public.nb_displays set last_seen_at=now() where id=d.id;
 end if;
 select revision into rev from public.nb_board_revision where singleton for share;
 v:=today::text||':'||rev;
 -- Initial connection establishes a baseline; reconnects recover only recent wins.
 select coalesce(jsonb_agg(to_jsonb(m) order by m.display_sequence),'[]') into events from (
  select id,player1,player2,score1,score2,games,date,revision,display_sequence from public.nb_matches
  where display_sequence>coalesce(p_cursor,rev) and created_at>now()-interval '2 minutes'
  order by display_sequence limit 100
 ) m;
 next_cursor:=case when jsonb_array_length(events)=100 then (events->99->>'display_sequence')::bigint else rev end;
 if p_version is distinct from v then
  snapshot:=jsonb_build_object(
   'players',(select coalesce(jsonb_agg(to_jsonb(p) order by p.name,p.id),'[]') from (
    select id,name,username,avatar,color,image_key is not null as photo from public.nb_players order by name,id limit 1000) p),
   'standings',public.nb_standings()->'standings'->'week',
   'today',today,'weekStart',date_trunc('week',today)::date,
   'matches',(select coalesce(jsonb_agg(to_jsonb(m) order by m.date desc,m.created_at desc,m.id desc),'[]') from (
    select id,player1,player2,score1,score2,games,date,revision,created_at from public.nb_matches order by date desc,created_at desc,id desc limit 12) m));
 end if;
 return jsonb_build_object('active',true,'version',v,'cursor',next_cursor::text,'events',events,'snapshot',snapshot,'serverTime',now());
end $$;
revoke all on function public.nb_display_state(text,text,bigint) from public,anon,authenticated;
grant execute on function public.nb_display_state(text,text,bigint) to project_admin;
