-- POST one bounded list rather than building large URLs or fanning out reads.
create function public.bb_game_content(p_games uuid[],p_player uuid)
returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object(
    'comments',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at,c.id)
      from public.bb_comments c where c.game_id=any(p_games) and c.deleted_at is null),'[]'),
    'reactions',coalesce((select jsonb_agg(to_jsonb(r))
      from public.bb_reactions r where r.game_id=any(p_games)),'[]'),
    'history',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc)
      from public.bb_activity a where a.game_id=any(p_games) and a.action in ('game.recorded','game.corrected')),'[]'),
    'subscriptions',coalesce((select jsonb_agg(to_jsonb(s))
      from public.bb_subscriptions s where s.game_id=any(p_games) and s.player_id=p_player),'[]'));
$$;
revoke all on function public.bb_game_content(uuid[],uuid) from public,anon,authenticated;
grant execute on function public.bb_game_content(uuid[],uuid) to project_admin;
