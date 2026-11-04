-- Freeze yesterday exclusions; finalization keeps only eligible reciprocal pairs.
create or replace function public.bb_daily_snapshot(p_now timestamptz default now())
returns jsonb language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare today date := (p_now at time zone 'America/Los_Angeles')::date;
  deadline timestamptz := (today+time '08:00') at time zone 'America/Los_Angeles';
  result jsonb; excluded_pairs jsonb;
begin
  if extract(isodow from today)>5 or p_now<deadline or p_now>=deadline+interval '2 hours' then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('bb-daily-'||today::text,0));
  if exists(select 1 from public.bb_daily_runs where day=today and queued_at is not null) then return null; end if;
  select coalesce(jsonb_agg(pair order by pair),'[]') into excluded_pairs from (
    select jsonb_build_array(least(player1,player2),greatest(player1,player2)) pair
      from public.bb_games where date=today-1 and created_at<=deadline
    union
    select pair from public.bb_daily_runs r cross join lateral jsonb_array_elements(coalesce(r.snapshot->'pairs','[]')) pair
      where r.day=today-1 and r.queued_at is not null
  ) excluded;
  select snapshot into result from public.bb_daily_runs where day=today;
  if found then
    if not result ? 'excludedPairs' then
      update public.bb_daily_runs set snapshot=snapshot||jsonb_build_object('excludedPairs',excluded_pairs)
        where day=today and queued_at is null returning snapshot into result;
      if not found then return null; end if;
    end if;
    return result;
  end if;
  select jsonb_build_object('day',today,'cutoff',deadline,'excludedPairs',excluded_pairs,
    'players',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'avatar',avatar,'image',case when image_key is not null then '/api/v1/photos/'||id end) order by id) from public.bb_players where daily_matchups and created_at<=deadline),'[]'),
    'history',coalesce((select jsonb_agg(jsonb_build_object('player1',a,'player2',b,'games',games,'lastPlayed',last_played) order by a,b) from (
      select least(player1,player2) a,greatest(player1,player2) b,count(*) games,max(date) last_played
      from public.bb_games where date>=today-28 and date<today and created_at<=deadline group by 1,2
    ) h),'[]'),
    'yesterdayGames',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,
      'player1',jsonb_build_object('id',p1.id,'name',p1.name,'avatar',p1.avatar,'image',case when p1.image_key is not null then '/api/v1/photos/'||p1.id end),
      'player2',jsonb_build_object('id',p2.id,'name',p2.name,'avatar',p2.avatar,'image',case when p2.image_key is not null then '/api/v1/photos/'||p2.id end),
      'score1',coalesce((a.after_data->>'score1')::integer,g.score1),
      'score2',coalesce((a.after_data->>'score2')::integer,g.score2)) order by g.created_at,g.id)
      from public.bb_games g join public.bb_players p1 on p1.id=g.player1 join public.bb_players p2 on p2.id=g.player2
      left join lateral (
        select after_data from public.bb_activity where game_id=g.id and action in ('game.recorded','game.corrected') and created_at<=deadline order by created_at desc,id desc limit 1
      ) a on true where g.date=today-1 and g.created_at<=deadline),'[]')) into result;
  insert into public.bb_daily_runs(day,cutoff,snapshot) values(today,deadline,result);
  return result;
end; $$;

create or replace function public.bb_queue_daily_matchups(p_day date,p_pairs jsonb)
returns integer language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare run public.bb_daily_runs; n integer; queued integer; fallback_players jsonb;
begin
  select * into run from public.bb_daily_runs where day=p_day for update;
  if not found or run.queued_at is not null then return 0; end if;
  n:=jsonb_array_length(run.snapshot->'players');
  if jsonb_typeof(p_pairs) is distinct from 'array' then raise exception 'Invalid daily lineup'; end if;
  select coalesce(jsonb_agg(p->>'id'),'[]') into fallback_players from jsonb_array_elements(run.snapshot->'players') p
    where not exists(select 1 from jsonb_array_elements(run.snapshot->'players') other where other->>'id'<>p->>'id'
      and not exists(select 1 from jsonb_array_elements(coalesce(run.snapshot->'excludedPairs','[]')) blocked
        where blocked ? (p->>'id') and blocked ? (other->>'id')));
  -- A repeat is allowed only to connect a player who has no fresh options.
  if jsonb_array_length(p_pairs)>n
    or exists(select 1 from jsonb_array_elements(p_pairs) e where jsonb_typeof(e)<>'array' or jsonb_array_length(e)<>2 or e->>0>=e->>1)
    or (select count(*) from (select distinct value from jsonb_array_elements(p_pairs)) p)<>jsonb_array_length(p_pairs)
    or exists(select 1 from jsonb_array_elements(p_pairs) e cross join lateral jsonb_array_elements_text(e) id where not exists(select 1 from jsonb_array_elements(run.snapshot->'players') p where p->>'id'=id))
    or exists(select 1 from jsonb_array_elements(run.snapshot->'players') p where (select count(*) from jsonb_array_elements(p_pairs) e where e ? (p->>'id'))>2)
    or exists(select 1 from jsonb_array_elements(p_pairs) pair join jsonb_array_elements(coalesce(run.snapshot->'excludedPairs','[]')) blocked on pair=blocked
      where not exists(select 1 from jsonb_array_elements_text(fallback_players) id where pair ? id))
    then raise exception 'Invalid daily lineup'; end if;
  update public.bb_daily_runs set snapshot=jsonb_set(snapshot,'{pairs}',p_pairs),queued_at=now() where day=p_day;
  insert into public.bb_outbox(event_id,recipient,subject,payload)
    select run.event_id,(p->>'id')::uuid,'Your opponents for today',jsonb_build_object('action','daily.matchups','day',p_day)
    from jsonb_array_elements(run.snapshot->'players') p join public.bb_players current_player on current_player.id=(p->>'id')::uuid
    where current_player.daily_matchups and (exists(select 1 from jsonb_array_elements(p_pairs) pair where pair ? (p->>'id'))
      or jsonb_array_length(coalesce(run.snapshot->'yesterdayGames','[]'))>0);
  get diagnostics queued=row_count;
  return queued;
end; $$;
revoke all on function public.bb_daily_snapshot(timestamptz),public.bb_queue_daily_matchups(date,jsonb) from public,anon,authenticated;
grant execute on function public.bb_daily_snapshot(timestamptz),public.bb_queue_daily_matchups(date,jsonb) to project_admin;
