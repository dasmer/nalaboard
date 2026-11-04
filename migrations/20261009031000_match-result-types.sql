-- Add result types without rewriting games, scores, or audit history.
create or replace function public.bb_series_wins(matches jsonb, side integer) returns integer
language plpgsql immutable strict set search_path=pg_catalog,public,pg_temp as $$
declare m jsonb; a integer; b integer; wins1 integer:=0; wins2 integer:=0;
begin
  if jsonb_typeof(matches)<>'array' then return null; end if;
  if jsonb_array_length(matches) not between 2 and 3 then return null; end if;
  for m in select value from jsonb_array_elements(matches) loop
    if wins1=2 or wins2=2 then return null; end if;
    if coalesce(m->>'type','exact')='exact' then
      if jsonb_typeof(m->'score1') is distinct from 'number' or jsonb_typeof(m->'score2') is distinct from 'number'
        or coalesce(m->>'score1','') !~ '^[0-9]{1,2}$' or coalesce(m->>'score2','') !~ '^[0-9]{1,2}$' or m ? 'winner' then return null; end if;
      a:=(m->>'score1')::integer; b:=(m->>'score2')::integer;
      if greatest(a,b)<>11 or least(a,b)>9 then return null; end if;
    elsif m->>'type' in ('deuce','unrecorded') then
      if jsonb_typeof(m->'winner') is distinct from 'number' or m->>'winner' not in ('1','2') or m ? 'score1' or m ? 'score2' then return null; end if;
      a:=case when m->>'winner'='1' then 1 else 0 end; b:=1-a;
    else return null;
    end if;
    if a>b then wins1:=wins1+1; else wins2:=wins2+1; end if;
  end loop;
  if greatest(wins1,wins2)<>2 then return null; end if;
  return case when side=1 then wins1 else wins2 end;
end; $$;
revoke all on function public.bb_series_wins(jsonb,integer) from public,anon,authenticated;
grant execute on function public.bb_series_wins(jsonb,integer) to project_admin;

create or replace function public.bb_standings() returns jsonb language sql stable set search_path = pg_catalog, public, pg_temp as $$
with periods(period,start_date) as (
  values ('all',date '0001-01-01'),
    ('month',date_trunc('month',now() at time zone 'America/Los_Angeles')::date),
    ('week',date_trunc('week',now() at time zone 'America/Los_Angeles')::date)
), sides as (
  select player1 id,player2 opponent,(score1>score2)::int win,date from public.bb_games
  union all select player2,player1,(score2>score1)::int,date from public.bb_games
), totals as (
  select periods.period,sides.id,count(*) played,sum(win) wins,count(*)-sum(win) losses,
    round(sum(win)*100.0/count(*)) rate
  from periods join sides on sides.date>=periods.start_date group by periods.period,sides.id
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
revoke all on function public.bb_standings() from public,anon,authenticated;
grant execute on function public.bb_standings() to project_admin;
