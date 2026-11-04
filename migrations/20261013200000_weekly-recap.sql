alter table public.bb_players add column weekly_recap boolean not null default true;
create table public.bb_weekly_runs (
  week_start date primary key,
  cutoff timestamptz not null,
  event_id uuid not null unique default gen_random_uuid(),
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.bb_weekly_runs enable row level security;
revoke all on public.bb_weekly_runs from public,anon,authenticated;
grant all on public.bb_weekly_runs to project_admin;

-- Freeze results and recipients in the same transaction. The PK plus lock make
-- concurrent servers and restarts harmless. Empty weeks are recorded but not sent.
create function public.bb_queue_weekly_recap(p_now timestamptz default now())
returns integer language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare local_now timestamp := p_now at time zone 'America/Los_Angeles';
  sunday date; deadline timestamptz; snapshot jsonb; event uuid; queued integer;
begin
  sunday := local_now::date-extract(dow from local_now)::integer;
  deadline := (sunday+5+time '19:30') at time zone 'America/Los_Angeles';
  if p_now<deadline then sunday:=sunday-7; deadline:=(sunday+5+time '19:30') at time zone 'America/Los_Angeles'; end if;
  -- Catch a brief outage without sending stale recaps or backfilling on launch.
  if p_now>=deadline+interval '24 hours' then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('bb-weekly-'||sunday::text,0));
  if exists(select 1 from public.bb_weekly_runs where week_start=sunday) then return 0; end if;
  select jsonb_build_object('weekStart',sunday,'weekEnd',sunday+5,
    'players',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'avatar',avatar,'color',color,'image',case when image_key is not null then '/api/v1/photos/'||id end) order by id) from public.bb_players),'[]'),
    'games',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'player1',g.player1,'player2',g.player2,'date',g.date,
      'score1',coalesce((a.after_data->>'score1')::integer,g.score1),
      'score2',coalesce((a.after_data->>'score2')::integer,g.score2),
      'matches',coalesce(a.after_data->'matches',g.matches)) order by g.date,g.created_at,g.id)
      from public.bb_games g left join lateral (
        select after_data from public.bb_activity where game_id=g.id and action in ('game.recorded','game.corrected') and created_at<=deadline order by created_at desc,id desc limit 1
      ) a on true where g.date between sunday and sunday+5 and g.created_at<=deadline),'[]')) into snapshot;
  insert into public.bb_weekly_runs(week_start,cutoff,snapshot) values(sunday,deadline,snapshot) returning event_id into event;
  if jsonb_array_length(snapshot->'games')=0 then return 0; end if;
  insert into public.bb_outbox(event_id,recipient,subject,payload)
    select event,id,'This week at the table',jsonb_build_object('action','weekly.recap','weekStart',sunday)
    from public.bb_players where weekly_recap and created_at<=deadline;
  get diagnostics queued=row_count;
  return queued;
end; $$;
revoke all on function public.bb_queue_weekly_recap(timestamptz) from public,anon,authenticated;
grant execute on function public.bb_queue_weekly_recap(timestamptz) to project_admin;

create function public.bb_weekly_preference(p_player uuid,p_enabled boolean)
returns jsonb language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare prior boolean;
begin
  select weekly_recap into prior from public.bb_players where id=p_player for update;
  if not found then return jsonb_build_object('error','Player not found.','status',404); end if;
  if prior is distinct from p_enabled then
    update public.bb_players set weekly_recap=p_enabled where id=p_player;
    insert into public.bb_activity(actor,action,description,before_data,after_data)
      values(p_player,'email.weekly.updated','Updated weekly recap preference',jsonb_build_object('weeklyRecap',prior),jsonb_build_object('weeklyRecap',p_enabled));
  end if;
  return jsonb_build_object('enabled',p_enabled);
end; $$;
revoke all on function public.bb_weekly_preference(uuid,boolean) from public,anon,authenticated;
grant execute on function public.bb_weekly_preference(uuid,boolean) to project_admin;
