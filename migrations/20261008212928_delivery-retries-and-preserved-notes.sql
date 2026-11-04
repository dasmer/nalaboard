-- All writes run in one database transaction. The server passes a hash of an
-- authenticated opaque credential, never a caller-supplied player identity.
create or replace function public.bb_mutate(p_token text,p_action text,p_game uuid,p_body jsonb,p_key text,p_fingerprint text)
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare s public.bb_sessions; g public.bb_games; old_data jsonb; result jsonb := '{}';
  existing public.bb_requests; event uuid := gen_random_uuid(); comment_id uuid;
  recipient uuid; mentioned uuid; description text; subject text; old_emoji text;
begin
  select * into s from public.bb_sessions where token_hash=p_token and revoked_at is null and expires_at>now() for share;
  if not found then return jsonb_build_object('error','Sign in to continue.','status',401); end if;
  if p_key is null or length(p_key) not between 1 and 128 then
    return jsonb_build_object('error','Provide an Idempotency-Key for writes.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(s.player_id::text||p_key,0));
  select * into existing from public.bb_requests where player_id=s.player_id and key=p_key;
  if found then
    if existing.fingerprint<>p_fingerprint then return jsonb_build_object('error','This request key was already used for a different action.','status',409); end if;
    return existing.response;
  end if;
  if p_action='game.recorded' then
    if (p_body->>'date')::date > (now() at time zone 'America/Los_Angeles')::date then
      return jsonb_build_object('error','Games cannot be recorded in the future.');
    end if;
    insert into public.bb_games(player1,player2,matches,date,notes)
    values(s.player_id,(p_body->>'opponent')::uuid,p_body->'matches',(p_body->>'date')::date,coalesce(p_body->>'notes','')) returning * into g;
    insert into public.bb_subscriptions(game_id,player_id) values(g.id,g.player1),(g.id,g.player2);
    description := 'Recorded a game'; subject := 'A new game is on the board';
    result := jsonb_build_object('id',g.id);
  elsif p_action in ('game.corrected','comment.added','comment.removed','reaction.updated','subscription.updated') then
    select * into g from public.bb_games where id=p_game for update;
    if not found then return jsonb_build_object('error','Match not found.','status',404); end if;
    if p_action='game.corrected' then
      if s.player_id not in (g.player1,g.player2) then return jsonb_build_object('error','Only participants can correct this match.','status',403); end if;
      if g.revision<>(p_body->>'revision')::integer or p_body->>'revision' is null then return jsonb_build_object('error','The score changed. Refresh before saving.','status',409); end if;
      old_data := jsonb_build_object('score1',g.score1,'score2',g.score2,'matches',g.matches,'notes',g.notes);
      update public.bb_games set matches=p_body->'matches',
        notes=case when p_body ? 'notes' then coalesce(p_body->>'notes','') else g.notes end,revision=revision+1 where id=g.id returning * into g;
      description := 'Corrected the score'; subject := 'Your match score was corrected';
    elsif p_action='comment.added' then
      -- Serialize subscriptions with comments on this game: newly mentioned
      -- people receive this comment and every subsequent comment.
      insert into public.bb_subscriptions(game_id,player_id) values(g.id,s.player_id) on conflict do nothing;
      for mentioned in select distinct value::uuid from jsonb_array_elements_text(coalesce(p_body->'mentions','[]')) loop
        if not exists(select 1 from public.bb_players where id=mentioned) then
          raise exception 'Mentioned player does not exist';
        end if;
        insert into public.bb_subscriptions(game_id,player_id) values(g.id,mentioned) on conflict do nothing;
      end loop;
      insert into public.bb_comments(game_id,player_id,text,mentions,agent)
      values(g.id,s.player_id,btrim(p_body->>'text'),array(select distinct value::uuid from jsonb_array_elements_text(coalesce(p_body->'mentions','[]'))),
        case when s.kind='agent' then s.label end) returning id into comment_id;
      description := 'Commented on this match'; subject := 'New table talk on your match';
      result := jsonb_build_object('id',comment_id);
    elsif p_action='comment.removed' then
      update public.bb_comments set deleted_at=now() where id=(p_body->>'id')::uuid and game_id=g.id and player_id=s.player_id and deleted_at is null;
      if not found then return jsonb_build_object('error','You can only remove your own comments.','status',403); end if;
      description := 'Removed a comment';
    elsif p_action='reaction.updated' then
      if p_body->>'emoji' not in ('🔥','🏓','😂','👏','😤') or p_body->>'emoji' is null then return jsonb_build_object('error','Choose a reaction.'); end if;
      select emoji into old_emoji from public.bb_reactions where game_id=g.id and player_id=s.player_id;
      if old_emoji=p_body->>'emoji' then
        delete from public.bb_reactions where game_id=g.id and player_id=s.player_id;
        description := 'Removed a reaction';
      else
        insert into public.bb_reactions(game_id,player_id,emoji) values(g.id,s.player_id,p_body->>'emoji')
          on conflict(game_id,player_id) do update set emoji=excluded.emoji;
        description := 'Reacted '||(p_body->>'emoji');
      end if;
    elsif p_action='subscription.updated' then
      insert into public.bb_subscriptions(game_id,player_id,muted) values(g.id,s.player_id,(p_body->>'muted')::boolean)
        on conflict(game_id,player_id) do update set muted=excluded.muted;
      description := case when (p_body->>'muted')::boolean then 'Muted match emails' else 'Subscribed to match emails' end;
    end if;
  else return jsonb_build_object('error','Unknown action.','status',404);
  end if;
  insert into public.bb_activity(id,actor,game_id,action,description,agent,before_data,after_data)
    values(event,s.player_id,g.id,p_action,description,case when s.kind='agent' then s.label end,old_data,
      case when p_action in ('game.recorded','game.corrected') then jsonb_build_object('score1',g.score1,'score2',g.score2,'matches',g.matches,'notes',g.notes) end);
  if subject is not null then
    for recipient in
      select p.id from public.bb_players p where p.notifications and p.id<>s.player_id and
      ((p_action in ('game.recorded','game.corrected') and p.id in (g.player1,g.player2)) or
       (p_action='comment.added' and exists(select 1 from public.bb_subscriptions sub where sub.game_id=g.id and sub.player_id=p.id and not sub.muted)))
    loop
      insert into public.bb_outbox(event_id,recipient,subject,payload) values(event,recipient,subject,
        jsonb_build_object('gameId',g.id,'actor',s.player_id,'action',p_action,'text',p_body->>'text','before',old_data,
          'after',jsonb_build_object('score1',g.score1,'score2',g.score2,'matches',g.matches)));
    end loop;
  end if;
  insert into public.bb_requests(player_id,key,fingerprint,response) values(s.player_id,p_key,p_fingerprint,result);
  return result;
end; $$;
revoke all on function public.bb_mutate(text,text,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.bb_mutate(text,text,uuid,jsonb,text,text) to project_admin;

alter table public.bb_outbox add column first_attempt_at timestamptz;
create or replace function public.bb_claim_emails(p_event uuid default null)
returns setof public.bb_outbox language sql set search_path=pg_catalog,public,pg_temp as $$
  update public.bb_outbox set leased_until=now()+interval '5 minutes',attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,now())
  where id in (select id from public.bb_outbox where sent_at is null and next_attempt_at<=now()
    and (leased_until is null or leased_until<now())
    -- Stop uncertain retries before Resend's 24-hour idempotency window expires.
    -- A delayed first attempt remains eligible, regardless of queue age.
    and (first_attempt_at is null or first_attempt_at>now()-interval '23 hours')
    and (p_event is null or event_id=p_event)
    order by created_at limit 20 for update skip locked) returning *;
$$;
