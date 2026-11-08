-- Display authority is separate from player sessions and never grants account access.
create table public.nb_display_admins (
  player_id uuid primary key references public.nb_players(id)
);
insert into public.nb_display_admins(player_id)
select id from public.nb_players where id in
 ('ec6dfd38-ba5b-4943-9f12-14c36f4bc610','ab823183-e985-4d44-b2cc-d3d57fedbae1');
create table public.nb_displays (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  pairing_expires_at timestamptz not null default now()+interval '5 minutes',
  activated_at timestamptz,
  activated_by uuid references public.nb_players(id),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.nb_activity add column display_id uuid references public.nb_displays(id);
create index nb_matches_created on public.nb_matches(created_at desc,id desc);
do $$ declare t text; begin
 foreach t in array array['nb_display_admins','nb_displays'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to project_admin',t);
 end loop;
end $$;

-- Serialized buckets also bound pairing attempts and avoid unlimited pending rows.
create function public.nb_display_limit(p_key text,p_max integer) returns boolean
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare b public.nb_rate_limits;
begin
 insert into public.nb_rate_limits(key) values(p_key) on conflict do nothing;
 select * into b from public.nb_rate_limits where key=p_key for update;
 if b.window_start < now()-interval '1 hour' then
  update public.nb_rate_limits set count=1,window_start=now() where key=p_key;
 elsif b.count>=p_max then return false;
 else update public.nb_rate_limits set count=count+1 where key=p_key;
 end if;
 return true;
end $$;
create function public.nb_display_begin(p_token text,p_code text,p_ip text) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare d public.nb_displays;
begin
 if not public.nb_display_limit('display:ip:'||p_ip,20) then
  return jsonb_build_object('error','Too many pairing requests. Try again later.','status',429);
 end if;
 insert into public.nb_displays(token_hash,code_hash) values(p_token,p_code) returning * into d;
 return jsonb_build_object('expiresAt',d.pairing_expires_at);
end $$;
create function public.nb_display_activate(p_admin uuid,p_code text,p_device text,p_personal text) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare d public.nb_displays; local_device boolean;
begin
 if not exists(select 1 from public.nb_display_admins where player_id=p_admin) then
  return jsonb_build_object('error','Only display admins can activate this screen.','status',403);
 end if;
 if not public.nb_display_limit('display:admin:'||p_admin,30) then
  return jsonb_build_object('error','Too many attempts. Try again later.','status',429);
 end if;
 select * into d from public.nb_displays where code_hash=p_code for update;
 if not found or d.activated_at is not null or d.revoked_at is not null or d.pairing_expires_at<=now() then
  return jsonb_build_object('error','This display code has expired or was already used.','status',409);
 end if;
 local_device:=coalesce(d.token_hash=p_device,false);
 -- Verification without a personal session is valid only on the target browser.
 if p_personal is null and not local_device then
  return jsonb_build_object('error','Open activation on the display again.','status',403);
 end if;
 update public.nb_displays set activated_at=now(),activated_by=p_admin,last_seen_at=now() where id=d.id;
 if local_device and p_personal is not null then
  update public.nb_sessions set revoked_at=now() where token_hash=p_personal;
 end if;
 return jsonb_build_object('ok',true,'local',local_device);
end $$;
create function public.nb_display_approve(p_token text,p_code text,p_device text) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare s public.nb_sessions;
begin
 select * into s from public.nb_sessions where token_hash=p_token and kind='web'
  and revoked_at is null and expires_at>now() for share;
 if not found then return jsonb_build_object('error','Sign in to activate a display.','status',401); end if;
 return public.nb_display_activate(s.player_id,p_code,p_device,p_token);
end $$;
create function public.nb_display_verify(p_email text,p_hash text,p_code text,p_device text,p_personal text) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare challenge public.nb_otp; person uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_email,0));
 select p.id into person from public.nb_players p join public.nb_display_admins a on a.player_id=p.id where p.email=p_email;
 if not found then return jsonb_build_object('error','Only display admins can activate this screen.','status',403); end if;
 select * into challenge from public.nb_otp where email=p_email for update;
 if not found or challenge.consumed_at is not null or challenge.expires_at<=now() or challenge.attempts>=3 then
  return jsonb_build_object('error','Request a new email code.','status',401);
 end if;
 if challenge.code_hash<>p_hash then
  update public.nb_otp set attempts=attempts+1 where email=p_email;
  return jsonb_build_object('error','That email code is incorrect.','status',401);
 end if;
 update public.nb_otp set consumed_at=now() where email=p_email;
 return public.nb_display_activate(person,p_code,p_device,p_personal);
end $$;
create function public.nb_display_revoke(p_token text,p_id uuid) returns jsonb
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 if not exists(select 1 from public.nb_sessions s join public.nb_display_admins a on a.player_id=s.player_id
  where s.token_hash=p_token and s.kind='web' and s.revoked_at is null and s.expires_at>now()) then
  return jsonb_build_object('error','Only display admins can disconnect displays.','status',403);
 end if;
 update public.nb_displays set revoked_at=now() where id=p_id;
 return jsonb_build_object('ok',true);
end $$;

-- Reuse the match transaction, validation, subscriptions, history and email queue.
-- A display credential may only record, and is explicitly attributed as a display.
create or replace function public.nb_mutate(p_token text,p_action text,p_match uuid,p_body jsonb,p_key text,p_fingerprint text)
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare s public.nb_sessions; g public.nb_matches; old_data jsonb; result jsonb := '{}';
  display public.nb_displays; existing public.nb_requests; event uuid := gen_random_uuid(); comment_id uuid;
  recipient uuid; mentioned uuid; description text; subject text; old_emoji text;
begin
  select * into s from public.nb_sessions where token_hash=p_token and revoked_at is null and expires_at>now() for share;
  if not found then
    select * into display from public.nb_displays where token_hash=p_token and activated_at is not null
      and revoked_at is null and last_seen_at>now()-interval '90 days' for share;
    if not found then return jsonb_build_object('error','Sign in to continue.','status',401); end if;
    if p_action<>'match.recorded' or p_match is not null then
      return jsonb_build_object('error','Displays can only record matches.','status',403);
    end if;
    s.player_id:=(p_body->>'player1')::uuid;
    if s.player_id is null then return jsonb_build_object('error','Choose both players.'); end if;
    s.kind:='display';
  end if;
  if p_key is null or length(p_key) not between 1 and 128 then
    return jsonb_build_object('error','Provide an Idempotency-Key for writes.');
  end if;
  if display.id is not null then p_key:=display.id::text||':'||p_key; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.player_id::text||p_key,0));
  select * into existing from public.nb_requests where player_id=s.player_id and key=p_key;
  if found then
    if existing.fingerprint<>p_fingerprint then return jsonb_build_object('error','This request key was already used for a different action.','status',409); end if;
    return existing.response;
  end if;
  if p_action='match.recorded' then
    if (p_body->>'date')::date > (now() at time zone 'Europe/London')::date then
      return jsonb_build_object('error','Matches cannot be recorded in the future.');
    end if;
    insert into public.nb_matches(player1,player2,games,date,notes)
    values(s.player_id,(p_body->>'opponent')::uuid,p_body->'games',(p_body->>'date')::date,coalesce(p_body->>'notes','')) returning * into g;
    insert into public.nb_subscriptions(match_id,player_id) values(g.id,g.player1),(g.id,g.player2);
    description := case when display.id is null then 'Recorded a match' else 'Recorded on the office display' end; subject := 'A new match is on the board';
    result := jsonb_build_object('id',g.id);
  elsif p_action in ('match.corrected','comment.added','comment.removed','reaction.updated','subscription.updated') then
    select * into g from public.nb_matches where id=p_match for update;
    if not found then return jsonb_build_object('error','Match not found.','status',404); end if;
    if p_action='match.corrected' then
      if s.player_id not in (g.player1,g.player2) then return jsonb_build_object('error','Only participants can correct this match.','status',403); end if;
      if g.revision<>(p_body->>'revision')::integer or p_body->>'revision' is null then return jsonb_build_object('error','The score changed. Refresh before saving.','status',409); end if;
      old_data := jsonb_build_object('score1',g.score1,'score2',g.score2,'games',g.games,'notes',g.notes);
      update public.nb_matches set games=p_body->'games',
        notes=case when p_body ? 'notes' then coalesce(p_body->>'notes','') else g.notes end,revision=revision+1 where id=g.id returning * into g;
      description := 'Corrected the score'; subject := 'Your match score was corrected';
    elsif p_action='comment.added' then
      -- Serialize subscriptions with comments on this match: newly mentioned
      -- people receive this comment and every subsequent comment.
      insert into public.nb_subscriptions(match_id,player_id) values(g.id,s.player_id) on conflict do nothing;
      for mentioned in select distinct value::uuid from jsonb_array_elements_text(coalesce(p_body->'mentions','[]')) loop
        if not exists(select 1 from public.nb_players where id=mentioned) then
          raise exception 'Mentioned player does not exist';
        end if;
        insert into public.nb_subscriptions(match_id,player_id) values(g.id,mentioned) on conflict do nothing;
      end loop;
      insert into public.nb_comments(match_id,player_id,text,mentions,agent)
      values(g.id,s.player_id,btrim(p_body->>'text'),array(select distinct value::uuid from jsonb_array_elements_text(coalesce(p_body->'mentions','[]'))),
        case when s.kind='agent' then s.label end) returning id into comment_id;
      description := 'Commented on this match'; subject := 'New table talk on your match';
      result := jsonb_build_object('id',comment_id);
    elsif p_action='comment.removed' then
      update public.nb_comments set deleted_at=now() where id=(p_body->>'id')::uuid and match_id=g.id and player_id=s.player_id and deleted_at is null;
      if not found then return jsonb_build_object('error','You can only remove your own comments.','status',403); end if;
      description := 'Removed a comment';
    elsif p_action='reaction.updated' then
      if p_body->>'emoji' not in ('🔥','🏓','😂','👏','😤') or p_body->>'emoji' is null then return jsonb_build_object('error','Choose a reaction.'); end if;
      select emoji into old_emoji from public.nb_reactions where match_id=g.id and player_id=s.player_id;
      if old_emoji=p_body->>'emoji' then
        delete from public.nb_reactions where match_id=g.id and player_id=s.player_id;
        description := 'Removed a reaction';
      else
        insert into public.nb_reactions(match_id,player_id,emoji) values(g.id,s.player_id,p_body->>'emoji')
          on conflict(match_id,player_id) do update set emoji=excluded.emoji;
        description := 'Reacted '||(p_body->>'emoji');
      end if;
    elsif p_action='subscription.updated' then
      insert into public.nb_subscriptions(match_id,player_id,muted) values(g.id,s.player_id,(p_body->>'muted')::boolean)
        on conflict(match_id,player_id) do update set muted=excluded.muted;
      description := case when (p_body->>'muted')::boolean then 'Muted match emails' else 'Subscribed to match emails' end;
    end if;
  else return jsonb_build_object('error','Unknown action.','status',404);
  end if;
  insert into public.nb_activity(id,actor,match_id,action,description,agent,before_data,after_data,display_id)
    values(event,s.player_id,g.id,p_action,description,case when s.kind='agent' then s.label end,old_data,
      case when p_action in ('match.recorded','match.corrected') then jsonb_build_object('score1',g.score1,'score2',g.score2,'games',g.games,'notes',g.notes) end,display.id);
  if subject is not null then
    for recipient in
      select p.id from public.nb_players p where p.notifications and p.id<>s.player_id and
      ((p_action in ('match.recorded','match.corrected') and p.id in (g.player1,g.player2)) or
       (p_action='comment.added' and exists(select 1 from public.nb_subscriptions sub where sub.match_id=g.id and sub.player_id=p.id and not sub.muted)))
    loop
      insert into public.nb_outbox(event_id,recipient,subject,payload) values(event,recipient,subject,
        jsonb_build_object('matchId',g.id,'actor',s.player_id,'action',p_action,'text',p_body->>'text','before',old_data,
          'after',jsonb_build_object('score1',g.score1,'score2',g.score2,'games',g.games)));
    end loop;
  end if;
  insert into public.nb_requests(player_id,key,fingerprint,response) values(s.player_id,p_key,p_fingerprint,result);
  return result;
end; $$;
do $$ declare f regprocedure; begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'nb_display_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
  execute format('grant execute on function %s to project_admin',f);
 end loop;
end $$;
