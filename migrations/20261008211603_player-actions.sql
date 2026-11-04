create function public.bb_player_action(p_token text,p_action text,p_body jsonb)
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare s public.bb_sessions; person public.bb_players; prior public.bb_players; key_id uuid; event uuid := gen_random_uuid(); description text;
begin
  select * into s from public.bb_sessions where token_hash=p_token and revoked_at is null and expires_at>now() for share;
  if not found then return jsonb_build_object('error','Sign in to continue.','status',401); end if;
  select * into prior from public.bb_players where id=s.player_id for update;
  if p_action='profile.updated' then
    update public.bb_players set name=coalesce(p_body->>'name',name),username=coalesce(p_body->>'username',username),
      bio=coalesce(p_body->>'bio',bio),avatar=coalesce(p_body->>'avatar',avatar),color=coalesce(p_body->>'color',color),
      image_key=case when p_body ? 'image_key' then p_body->>'image_key' else image_key end,
      notifications=coalesce((p_body->>'notifications')::boolean,notifications)
      where id=s.player_id returning * into person;
    description := 'Updated player card';
  elsif p_action='agent.connected' then
    if length(coalesce(p_body->>'label','')) not between 1 and 60 then return jsonb_build_object('error','Choose an agent name under 60 characters.'); end if;
    if (select count(*) from public.bb_sessions where player_id=s.player_id and kind='agent' and revoked_at is null and expires_at>now())>=20 then
      return jsonb_build_object('error','Disconnect an old agent before adding another.');
    end if;
    insert into public.bb_sessions(player_id,token_hash,kind,label,expires_at)
      values(s.player_id,p_body->>'token_hash','agent',p_body->>'label',now()+interval '90 days') returning id into key_id;
    description := 'Connected '||(p_body->>'label');
    insert into public.bb_outbox(event_id,recipient,subject,payload) values(event,s.player_id,'A new agent connected to Burntboard',
      jsonb_build_object('actor',s.player_id,'action',p_action,'label',p_body->>'label'));
  elsif p_action='agent.disconnected' then
    update public.bb_sessions set revoked_at=now() where id=(p_body->>'id')::uuid and player_id=s.player_id and kind='agent' and revoked_at is null;
    if not found then return jsonb_build_object('error','Connection not found.','status',404); end if;
    description := 'Disconnected an agent';
  else return jsonb_build_object('error','Unknown action.');
  end if;
  insert into public.bb_activity(id,actor,action,description,agent,before_data,after_data)
    values(event,s.player_id,p_action,description,case when s.kind='agent' then s.label end,
      case when p_action='profile.updated' then jsonb_build_object('username',prior.username,'bio',prior.bio,'name',prior.name) end,
      case when p_action='profile.updated' then jsonb_build_object('username',person.username,'bio',person.bio,'name',person.name) end);
  return jsonb_build_object('ok',true,'id',key_id);
end; $$;
revoke all on function public.bb_player_action(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.bb_player_action(text,text,jsonb) to project_admin;
