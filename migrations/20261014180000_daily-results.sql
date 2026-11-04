-- Include yesterday’s public results in the existing immutable morning snapshot.
create or replace function public.bb_daily_snapshot(p_now timestamptz default now())
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
revoke all on function public.bb_daily_snapshot(timestamptz) from public,anon,authenticated;
grant execute on function public.bb_daily_snapshot(timestamptz) to project_admin;
