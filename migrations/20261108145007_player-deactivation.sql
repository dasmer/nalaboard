-- Preserve historical identities and results; only active players can participate.
alter table public.nb_players add column active boolean not null default true;
create table public.nb_player_admins(player_id uuid primary key references public.nb_players(id));
insert into public.nb_player_admins(player_id)
 select id from public.nb_players where id in ('ec6dfd38-ba5b-4943-9f12-14c36f4bc610','ab823183-e985-4d44-b2cc-d3d57fedbae1');
alter table public.nb_player_admins enable row level security;
revoke all on public.nb_player_admins from public,anon,authenticated;
grant all on public.nb_player_admins to project_admin;

create function public.nb_set_player_active(p_token text,p_player uuid,p_active boolean) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare s public.nb_sessions; target public.nb_players;
begin
 -- Serialize admin actions, then recheck the caller after acquiring the lock.
 perform pg_advisory_xact_lock(hashtextextended('nb-player-admin',0));
 select * into s from public.nb_sessions where token_hash=p_token and kind='web'
  and revoked_at is null and expires_at>now() for share;
 if not found then return jsonb_build_object('error','Sign in to manage players.','status',401); end if;
 if not exists(select 1 from public.nb_player_admins a join public.nb_players p on p.id=a.player_id where p.id=s.player_id and p.active) then
  return jsonb_build_object('error','Only player admins can manage accounts.','status',403);
 end if;
 if p_active is null then return jsonb_build_object('error','Choose an account status.','status',400); end if;
 if p_player=s.player_id then return jsonb_build_object('error','You cannot deactivate your own account.','status',403); end if;
 select * into target from public.nb_players where id=p_player;
 if not found then return jsonb_build_object('error','Player not found.','status',404); end if;
 if target.active=p_active then return jsonb_build_object('ok',true,'active',p_active); end if;
 -- Coordinate with OTP issuance/verification, and drain writes holding session
 -- locks before updating the player. Existing office displays belong to the office.
 perform pg_advisory_xact_lock(hashtextextended(target.email,0));
 if not p_active then
  update public.nb_sessions set revoked_at=now() where player_id=p_player and revoked_at is null;
  delete from public.nb_otp where email=target.email;
 end if;
 update public.nb_players set active=p_active where id=p_player;
 if not p_active then
  update public.nb_outbox set sent_at=now(),leased_until=null,last_error='Account inactive'
   where recipient=p_player and sent_at is null;
 end if;
 insert into public.nb_activity(actor,action,description,before_data,after_data)
 values(s.player_id,case when p_active then 'player.reactivated' else 'player.deactivated' end,
  (case when p_active then 'Reactivated ' else 'Deactivated ' end)||target.name,
  jsonb_build_object('playerId',p_player,'active',target.active),jsonb_build_object('playerId',p_player,'active',p_active));
 return jsonb_build_object('ok',true,'active',p_active);
end $$;
revoke all on function public.nb_set_player_active(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.nb_set_player_active(text,uuid,boolean) to project_admin;

-- Lock participants until each recording commits so deactivation cannot race
-- a new result from a shared display or personal/agent session. Corrections stay valid.
create function public.nb_require_active_match_players() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare p record;
begin
 for p in select id,active from public.nb_players where id in (new.player1,new.player2) order by id for share loop
  if not p.active then raise exception 'Inactive players cannot record new matches' using errcode='23514'; end if;
 end loop;
 return new;
end $$;
create trigger nb_match_active_players before insert on public.nb_matches for each row execute function public.nb_require_active_match_players();

-- Covers every email producer, including scheduled snapshots created earlier.
create function public.nb_require_active_email_recipient() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare enabled boolean;
begin
 select active into enabled from public.nb_players where id=new.recipient for share;
 if enabled is false then return null; end if;
 return new;
end $$;
create trigger nb_email_active_recipient before insert on public.nb_outbox for each row execute function public.nb_require_active_email_recipient();
revoke all on function public.nb_require_active_match_players(),public.nb_require_active_email_recipient() from public,anon,authenticated;
grant execute on function public.nb_require_active_match_players(),public.nb_require_active_email_recipient() to project_admin;


create or replace function public.nb_request_otp(p_email text, p_hash text, p_ip text)
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare bucket public.nb_rate_limits; challenge public.nb_otp; k text;
begin
  if p_email !~ '^[^@[:space:]]+@(useallowance\.com|nala\.money|rafiki\.com)$' then
    return jsonb_build_object('error','Use your @nala.money, @rafiki.com, or @useallowance.com email.','status',400);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_email,0));
  if exists(select 1 from public.nb_players where email=p_email and not active) then
    return jsonb_build_object('error','This account is inactive. Contact your office admin.','status',403);
  end if;
  foreach k in array array['otp:email:'||p_email,'otp:ip:'||p_ip] loop
    insert into public.nb_rate_limits(key) values(k) on conflict do nothing;
    select * into bucket from public.nb_rate_limits where key=k for update;
    if bucket.window_start < now()-interval '1 hour' then
      update public.nb_rate_limits set count=1,window_start=now() where key=k;
    elsif bucket.count >= (case when k like 'otp:ip:%' then 20 else 5 end) then
      return jsonb_build_object('error','Too many sign-in requests. Try again later.','status',429);
    else update public.nb_rate_limits set count=count+1 where key=k;
    end if;
  end loop;
  select * into challenge from public.nb_otp where email=p_email;
  if challenge.requested_at > now()-interval '60 seconds' then
    return jsonb_build_object('error','Wait a minute before requesting another code.','status',429);
  end if;
  insert into public.nb_otp(email,code_hash,expires_at) values(p_email,p_hash,now()+interval '10 minutes')
  on conflict(email) do update set code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at,requested_at=now(),consumed_at=null;
  return jsonb_build_object('email',p_email);
end; $$;

create or replace function public.nb_verify_otp(p_email text,p_hash text,p_token_hash text,p_kind text default 'web')
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare challenge public.nb_otp; person public.nb_players; fresh boolean := false; handle text;
begin
  if p_kind not in ('web','agent') then return jsonb_build_object('error','Invalid session kind.'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_email,0));
  if exists(select 1 from public.nb_players where email=p_email and not active) then
    return jsonb_build_object('error','This account is inactive. Contact your office admin.','status',403);
  end if;
  select * into challenge from public.nb_otp where email=p_email for update;
  if not found or challenge.consumed_at is not null or challenge.expires_at <= now() or challenge.attempts >= 3 then
    return jsonb_build_object('error','Request a new sign-in code.','status',401);
  end if;
  if challenge.code_hash <> p_hash then
    update public.nb_otp set attempts=attempts+1 where email=p_email;
    return jsonb_build_object('error','That code is incorrect.','status',401);
  end if;
  update public.nb_otp set consumed_at=now() where email=p_email;
  select * into person from public.nb_players where email=p_email;
  if not found then
    fresh := true;
    handle := left(regexp_replace(split_part(p_email,'@',1),'[^a-z0-9_]','','g'),14);
    if length(handle)<2 then handle:='player'; end if;
    handle := handle || '_' || substr(replace(gen_random_uuid()::text,'-',''),1,8);
    insert into public.nb_players(email,name,username) values(p_email,split_part(p_email,'@',1),handle) returning * into person;
  end if;
  insert into public.nb_sessions(player_id,token_hash,kind,label,expires_at)
  values(person.id,p_token_hash,p_kind,case when p_kind='web' then 'Browser' else 'Agent login' end,
    now()+case when p_kind='web' then interval '30 days' else interval '90 days' end);
  insert into public.nb_activity(actor,action,description,agent)
  values(person.id,case when fresh then 'account.created' else 'session.started' end,
    case when fresh then 'Joined the clubhouse' else 'Signed in' end,case when p_kind='agent' then 'Agent login' end);
  if p_kind='agent' then
    insert into public.nb_outbox(event_id,recipient,subject,payload) values(gen_random_uuid(),person.id,'A new agent connected to Nalaboard',
      jsonb_build_object('actor',person.id,'action','agent.connected','label','Agent login'));
  end if;
  return jsonb_build_object('isNew',fresh,'playerId',person.id);
end; $$;

create or replace function public.nb_standings() returns jsonb language sql stable set search_path = pg_catalog, public, pg_temp as $$
with periods(period,start_date) as (
  values ('all',date '0001-01-01'),
    ('month',date_trunc('month',now() at time zone 'Europe/London')::date),
    ('week',date_trunc('week',now() at time zone 'Europe/London')::date)
), sides as (
  select player1 id,player2 opponent,(score1>score2)::int win,date from public.nb_matches
  union all select player2,player1,(score2>score1)::int,date from public.nb_matches
), totals as (
  select periods.period,sides.id,count(*) played,sum(win) wins,count(*)-sum(win) losses,
    round(sum(win)*100.0/count(*)) rate
  from periods join sides on sides.date>=periods.start_date join public.nb_players p on p.id=sides.id
  where periods.period='all' or p.active group by periods.period,sides.id
), standings as (
  select periods.period,coalesce(jsonb_agg(to_jsonb(totals)-'period') filter(where totals.id is not null),'[]') rows
  from periods left join totals using(period) group by periods.period
), rivals as (
  select id,opponent,count(*) played,sum(win) wins,count(*)-sum(win) losses,
    round(sum(win)*100.0/count(*)) rate from sides group by id,opponent
)
select jsonb_build_object('standings',(select jsonb_object_agg(period,rows) from standings),
  'rivalries',coalesce((select jsonb_agg(to_jsonb(rivals)) from rivals),'[]'),
  'weekStart',(select start_date from periods where period='week'),
  'monthStart',(select start_date from periods where period='month'));
$$;

create or replace function public.nb_daily_snapshot(p_now timestamptz default now())
returns jsonb language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare today date := (p_now at time zone 'Europe/London')::date;
  deadline timestamptz := (today+time '08:00') at time zone 'Europe/London';
  result jsonb; excluded_pairs jsonb;
begin
  if extract(isodow from today)>5 or p_now<deadline or p_now>=deadline+interval '2 hours' then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('nb-daily-'||today::text,0));
  if exists(select 1 from public.nb_daily_runs where day=today and queued_at is not null) then return null; end if;
  select coalesce(jsonb_agg(pair order by pair),'[]') into excluded_pairs from (
    select jsonb_build_array(least(player1,player2),greatest(player1,player2)) pair
      from public.nb_matches where date=today-1 and created_at<=deadline
    union
    select pair from public.nb_daily_runs r cross join lateral jsonb_array_elements(coalesce(r.snapshot->'pairs','[]')) pair
      where r.day=today-1 and r.queued_at is not null
  ) excluded;
  select snapshot into result from public.nb_daily_runs where day=today;
  if found then
    if not result ? 'excludedPairs' then
      update public.nb_daily_runs set snapshot=snapshot||jsonb_build_object('excludedPairs',excluded_pairs)
        where day=today and queued_at is null returning snapshot into result;
      if not found then return null; end if;
    end if;
    -- A not-yet-queued snapshot must not pair a player deactivated since creation.
    return jsonb_set(result,'{players}',coalesce((select jsonb_agg(p) from jsonb_array_elements(result->'players') p
      join public.nb_players current_player on current_player.id=(p->>'id')::uuid where current_player.active),'[]'));
  end if;
  select jsonb_build_object('day',today,'cutoff',deadline,'excludedPairs',excluded_pairs,
    'players',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'avatar',avatar,'image',case when image_key is not null then '/api/v1/photos/'||id end) order by id) from public.nb_players where active and daily_matchups and created_at<=deadline),'[]'),
    'history',coalesce((select jsonb_agg(jsonb_build_object('player1',a,'player2',b,'matches',matches,'lastPlayed',last_played) order by a,b) from (
      select least(player1,player2) a,greatest(player1,player2) b,count(*) matches,max(date) last_played
      from public.nb_matches where date>=today-28 and date<today and created_at<=deadline group by 1,2
    ) h),'[]'),
    'yesterdayMatches',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,
      'player1',jsonb_build_object('id',p1.id,'name',p1.name,'avatar',p1.avatar,'image',case when p1.image_key is not null then '/api/v1/photos/'||p1.id end),
      'player2',jsonb_build_object('id',p2.id,'name',p2.name,'avatar',p2.avatar,'image',case when p2.image_key is not null then '/api/v1/photos/'||p2.id end),
      'score1',coalesce((a.after_data->>'score1')::integer,g.score1),
      'score2',coalesce((a.after_data->>'score2')::integer,g.score2)) order by g.created_at,g.id)
      from public.nb_matches g join public.nb_players p1 on p1.id=g.player1 join public.nb_players p2 on p2.id=g.player2
      left join lateral (
        select after_data from public.nb_activity where match_id=g.id and action in ('match.recorded','match.corrected') and created_at<=deadline order by created_at desc,id desc limit 1
      ) a on true where g.date=today-1 and g.created_at<=deadline),'[]')) into result;
  insert into public.nb_daily_runs(day,cutoff,snapshot) values(today,deadline,result);
  return result;
end; $$;

create or replace function public.nb_display_state(p_token text,p_version text default null,p_cursor bigint default null) returns jsonb
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
    select id,name,username,avatar,color,active,image_key is not null as photo from public.nb_players order by name,id limit 1000) p),
   'standings',public.nb_standings()->'standings'->'week',
   'today',today,'weekStart',date_trunc('week',today)::date,
   'matches',(select coalesce(jsonb_agg(to_jsonb(m) order by m.date desc,m.created_at desc,m.id desc),'[]') from (
    select id,player1,player2,score1,score2,games,date,revision,created_at from public.nb_matches order by date desc,created_at desc,id desc limit 12) m));
 end if;
 return jsonb_build_object('active',true,'version',v,'cursor',next_cursor::text,'events',events,'snapshot',snapshot,'serverTime',now());
end $$;

create or replace function public.nb_display_activate(p_admin uuid,p_code text,p_device text,p_personal text) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare d public.nb_displays; local_device boolean;
begin
 if not exists(select 1 from public.nb_display_admins a join public.nb_players p on p.id=a.player_id where p.id=p_admin and p.active) then
  return jsonb_build_object('error','Only display admins can activate this screen.','status',403);
 end if;
 if not public.nb_display_limit('display:admin:'||p_admin,30) then
  return jsonb_build_object('error','Too many attempts. Try again later.','status',429);
 end if;
 select * into d from public.nb_displays where code_hash=p_code for update;
 if not found or d.activated_at is not null or d.revoked_at is not null or d.pairing_expires_at<=now() then
  return jsonb_build_object('error','This display code has expired or was already used.','status',409);
 end if;
 local_device:=coalesce(d.token_hash=p_device,false);
 -- Verification without a personal session is valid only on the target browser.
 if p_personal is null and not local_device then
  return jsonb_build_object('error','Open activation on the display again.','status',403);
 end if;
 update public.nb_displays set activated_at=now(),activated_by=p_admin,last_seen_at=now() where id=d.id;
 if local_device and p_personal is not null then
  update public.nb_sessions set revoked_at=now() where token_hash=p_personal;
 end if;
 return jsonb_build_object('ok',true,'local',local_device);
end $$;

create or replace function public.nb_display_verify(p_email text,p_hash text,p_code text,p_device text,p_personal text) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare challenge public.nb_otp; person uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_email,0));
 select p.id into person from public.nb_players p join public.nb_display_admins a on a.player_id=p.id where p.email=p_email and p.active;
 if not found then return jsonb_build_object('error','Only display admins can activate this screen.','status',403); end if;
 select * into challenge from public.nb_otp where email=p_email for update;
 if not found or challenge.consumed_at is not null or challenge.expires_at<=now() or challenge.attempts>=3 then
  return jsonb_build_object('error','Request a new email code.','status',401);
 end if;
 if challenge.code_hash<>p_hash then
  update public.nb_otp set attempts=attempts+1 where email=p_email;
  return jsonb_build_object('error','That email code is incorrect.','status',401);
 end if;
 update public.nb_otp set consumed_at=now() where email=p_email;
 return public.nb_display_activate(person,p_code,p_device,p_personal);
end $$;
