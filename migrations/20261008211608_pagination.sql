create function public.nb_page_games(p_player uuid default null,p_time timestamptz default null,p_id uuid default null)
returns setof public.nb_games language sql set search_path=pg_catalog,public,pg_temp as $$
  select * from public.nb_games
  where (p_player is null or p_player in (player1,player2))
    and (p_time is null or (created_at,id)<(p_time,p_id))
  order by created_at desc,id desc limit 100;
$$;
create function public.nb_page_activity(p_time timestamptz default null,p_id uuid default null)
returns setof public.nb_activity language sql set search_path=pg_catalog,public,pg_temp as $$
  select * from public.nb_activity where p_time is null or (created_at,id)<(p_time,p_id)
  order by created_at desc,id desc limit 100;
$$;
revoke all on function public.nb_page_games(uuid,timestamptz,uuid),public.nb_page_activity(timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.nb_page_games(uuid,timestamptz,uuid),public.nb_page_activity(timestamptz,uuid) to project_admin;
