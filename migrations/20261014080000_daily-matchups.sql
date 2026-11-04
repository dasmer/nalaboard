alter table public.bb_players add column daily_matchups boolean not null default true;
create table public.bb_daily_runs (
  day date primary key,
  cutoff timestamptz not null,
  event_id uuid not null unique default gen_random_uuid(),
  snapshot jsonb not null,
  queued_at timestamptz
);
alter table public.bb_daily_runs enable row level security;
revoke all on public.bb_daily_runs from public,anon,authenticated;
grant all on public.bb_daily_runs to project_admin;

-- Freeze one shared roster/history, then let the server calculate its lineup.
-- A failed server can resume this snapshot; neither stage duplicates delivery.
create function public.bb_daily_snapshot(p_now timestamptz default now())
returns jsonb language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare today date := (p_now at time zone 'America/Los_Angeles')::date;
  deadline timestamptz := (today+time '08:00') at time zone 'America/Los_Angeles';
  result jsonb;
begin
  if extract(isodow from today)>5 or p_now<deadline or p_now>=deadline+interval '2 hours' then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('bb-daily-'||today::text,0));
  if exists(select 1 from public.bb_daily_runs where day=today and queued_at is not null) then return null; end if;
  select snapshot into result from public.bb_daily_runs where day=today;
  if found then return result; end if;
  select jsonb_build_object('day',today,'cutoff',deadline,
    'players',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'avatar',avatar,'image',case when image_key is not null then '/api/v1/photos/'||id end) order by id) from public.bb_players where daily_matchups and created_at<=deadline),'[]'),
    'history',coalesce((select jsonb_agg(jsonb_build_object('player1',a,'player2',b,'games',games,'lastPlayed',last_played) order by a,b) from (
      select least(player1,player2) a,greatest(player1,player2) b,count(*) games,max(date) last_played
      from public.bb_games where date>=today-28 and date<today and created_at<=deadline group by 1,2
    ) h),'[]')) into result;
  insert into public.bb_daily_runs(day,cutoff,snapshot) values(today,deadline,result);
  return result;
end; $$;

create function public.bb_queue_daily_matchups(p_day date,p_pairs jsonb)
returns integer language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare run public.bb_daily_runs; n integer; queued integer;
begin
  select * into run from public.bb_daily_runs where day=p_day for update;
  if not found or run.queued_at is not null then return 0; end if;
  n:=jsonb_array_length(run.snapshot->'players');
  if jsonb_typeof(p_pairs) is distinct from 'array' then raise exception 'Invalid daily lineup'; end if;
  -- Enforce the entire reciprocal degree-one/two lineup before any email queues.
  if jsonb_array_length(p_pairs)<>(case when n<2 then 0 when n=2 then 1 else n end)
    or exists(select 1 from jsonb_array_elements(p_pairs) e where jsonb_typeof(e)<>'array' or jsonb_array_length(e)<>2 or e->>0>=e->>1)
    or (select count(*) from (select distinct value from jsonb_array_elements(p_pairs)) p)<>jsonb_array_length(p_pairs)
    or exists(select 1 from jsonb_array_elements(p_pairs) e cross join lateral jsonb_array_elements_text(e) id where not exists(select 1 from jsonb_array_elements(run.snapshot->'players') p where p->>'id'=id))
    or exists(select 1 from jsonb_array_elements(run.snapshot->'players') p where (select count(*) from jsonb_array_elements(p_pairs) e where e ? (p->>'id'))<>least(2,greatest(0,n-1)))
    then raise exception 'Invalid daily lineup'; end if;
  update public.bb_daily_runs set snapshot=jsonb_set(snapshot,'{pairs}',p_pairs),queued_at=now() where day=p_day;
  insert into public.bb_outbox(event_id,recipient,subject,payload)
    select run.event_id,(p->>'id')::uuid,'Your opponents for today',jsonb_build_object('action','daily.matchups','day',p_day)
    from jsonb_array_elements(run.snapshot->'players') p join public.bb_players current_player on current_player.id=(p->>'id')::uuid
    where n>=2 and current_player.daily_matchups;
  get diagnostics queued=row_count;
  return queued;
end; $$;

create function public.bb_daily_preference(p_player uuid,p_enabled boolean)
returns jsonb language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare prior boolean;
begin
  select daily_matchups into prior from public.bb_players where id=p_player for update;
  if not found then return jsonb_build_object('error','Player not found.','status',404); end if;
  if prior is distinct from p_enabled then
    update public.bb_players set daily_matchups=p_enabled where id=p_player;
    insert into public.bb_activity(actor,action,description,before_data,after_data)
      values(p_player,'email.daily.updated','Updated daily matchup preference',jsonb_build_object('dailyMatchups',prior),jsonb_build_object('dailyMatchups',p_enabled));
  end if;
  return jsonb_build_object('enabled',p_enabled);
end; $$;
revoke all on function public.bb_daily_snapshot(timestamptz),public.bb_queue_daily_matchups(date,jsonb),public.bb_daily_preference(uuid,boolean) from public,anon,authenticated;
grant execute on function public.bb_daily_snapshot(timestamptz),public.bb_queue_daily_matchups(date,jsonb),public.bb_daily_preference(uuid,boolean) to project_admin;
