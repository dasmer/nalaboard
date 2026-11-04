create function public.bb_page_games(p_player uuid default null,p_time timestamptz default null,p_id uuid default null)
returns setof public.bb_games language sql set search_path=pg_catalog,public,pg_temp as $$
  select * from public.bb_games
  where (p_player is null or p_player in (player1,player2))
    and (p_time is null or (created_at,id)<(p_time,p_id))
  order by created_at desc,id desc limit 100;
$$;
create function public.bb_page_activity(p_time timestamptz default null,p_id uuid default null)
returns setof public.bb_activity language sql set search_path=pg_catalog,public,pg_temp as $$
  select * from public.bb_activity where p_time is null or (created_at,id)<(p_time,p_id)
  order by created_at desc,id desc limit 100;
$$;
revoke all on function public.bb_page_games(uuid,timestamptz,uuid),public.bb_page_activity(timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.bb_page_games(uuid,timestamptz,uuid),public.bb_page_activity(timestamptz,uuid) to project_admin;
