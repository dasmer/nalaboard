-- Game feeds use played date; recording time and ID break same-day ties.
create function public.bb_page_games_played(p_player uuid default null,p_date date default null,p_time timestamptz default null,p_id uuid default null)
returns setof public.bb_games language sql set search_path=pg_catalog,public,pg_temp as $$
  select * from public.bb_games
  where (p_player is null or p_player in (player1,player2))
    and (p_date is null or (date,created_at,id)<(p_date,p_time,p_id))
  order by date desc,created_at desc,id desc limit 100;
$$;
revoke all on function public.bb_page_games_played(uuid,date,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.bb_page_games_played(uuid,date,timestamptz,uuid) to project_admin;
