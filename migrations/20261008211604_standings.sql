create function public.bb_standings() returns jsonb language sql stable set search_path = pg_catalog, public, pg_temp as $$
with periods(period,start_date) as (
  values ('all',date '0001-01-01'),
    ('month',date_trunc('month',now() at time zone 'America/Los_Angeles')::date),
    ('week',date_trunc('week',now() at time zone 'America/Los_Angeles')::date)
), sides as (
  select player1 id,player2 opponent,(select sum((m->>'score1')::integer) from jsonb_array_elements(matches) m) points,(score1>score2)::int win,date from public.bb_games
  union all select player2,player1,(select sum((m->>'score2')::integer) from jsonb_array_elements(matches) m),(score2>score1)::int,date from public.bb_games
), totals as (
  select periods.period,sides.id,count(*) played,sum(win) wins,count(*)-sum(win) losses,sum(points) points,
    round(sum(win)*100.0/count(*)) rate
  from periods join sides on sides.date>=periods.start_date group by periods.period,sides.id
), standings as (
  select periods.period,coalesce(jsonb_agg(to_jsonb(totals)-'period') filter(where totals.id is not null),'[]') rows
  from periods left join totals using(period) group by periods.period
), rivals as (
  select id,opponent,count(*) played,sum(win) wins,count(*)-sum(win) losses,sum(points) points,
    round(sum(win)*100.0/count(*)) rate from sides group by id,opponent
)
select jsonb_build_object('standings',(select jsonb_object_agg(period,rows) from standings),
  'rivalries',coalesce((select jsonb_agg(to_jsonb(rivals)) from rivals),'[]'),
  'weekStart',(select start_date from periods where period='week'),
  'monthStart',(select start_date from periods where period='month'));
$$;
revoke all on function public.bb_standings() from public,anon,authenticated;
grant execute on function public.bb_standings() to project_admin;
