-- Coordinated API/database cutover: match = complete result, game = contest to 11.
-- No compatibility views, aliases, or runtime translation layer are retained.
alter table public.nb_games rename to nb_matches;
alter table public.nb_matches rename column matches to games;
alter table public.nb_comments rename column game_id to match_id;
alter table public.nb_reactions rename column game_id to match_id;
alter table public.nb_subscriptions rename column game_id to match_id;
alter table public.nb_activity rename column game_id to match_id;

-- Keep catalog names consistent with their renamed tables and columns.
alter table public.nb_matches rename constraint nb_games_notes_check to nb_matches_notes_check;
alter table public.nb_matches rename constraint nb_games_check to nb_matches_check;
alter table public.nb_matches rename constraint nb_games_pkey to nb_matches_pkey;
alter table public.nb_matches rename constraint nb_games_player1_fkey to nb_matches_player1_fkey;
alter table public.nb_matches rename constraint nb_games_player2_fkey to nb_matches_player2_fkey;
alter table public.nb_comments rename constraint nb_comments_game_id_fkey to nb_comments_match_id_fkey;
alter table public.nb_reactions rename constraint nb_reactions_game_id_fkey to nb_reactions_match_id_fkey;
alter table public.nb_subscriptions rename constraint nb_subscriptions_game_id_fkey to nb_subscriptions_match_id_fkey;
alter table public.nb_activity rename constraint nb_activity_game_id_fkey to nb_activity_match_id_fkey;
alter index public.nb_games_date rename to nb_matches_date;
alter index public.nb_comments_game rename to nb_comments_match;
alter index public.nb_activity_game rename to nb_activity_match;

-- New parameter names require new function signatures rather than aliases.
drop function public.nb_mutate(text,text,uuid,jsonb,text,text);
drop function public.nb_game_content(uuid[],uuid);
drop function public.nb_page_games(uuid,timestamptz,uuid);
drop function public.nb_page_games_played(uuid,date,timestamptz,uuid);

-- Rebuild the derived columns against the renamed validator. Row IDs, results,
-- revisions, dates, subscriptions, and foreign-key relationships are retained.
alter table public.nb_matches drop column score1, drop column score2;
drop function public.nb_series_wins(jsonb,integer);


create or replace function public.nb_game_wins(games jsonb, side integer) returns integer
language plpgsql immutable strict set search_path=pg_catalog,public,pg_temp as $$
declare m jsonb; a integer; b integer; wins1 integer:=0; wins2 integer:=0;
begin
  if jsonb_typeof(games)<>'array' then return null; end if;
  if jsonb_array_length(games) not between 1 and 3 then return null; end if;
  for m in select value from jsonb_array_elements(games) loop
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
  if greatest(wins1,wins2)<>(case when jsonb_array_length(games)=1 then 1 else 2 end) then return null; end if;
  return case when side=1 then wins1 else wins2 end;
end; $$;


alter table public.nb_matches
  add column score1 integer generated always as (public.nb_game_wins(games,1)) stored not null,
  add column score2 integer generated always as (public.nb_game_wins(games,2)) stored not null;

-- One-time JSON key migration, removed before the transaction completes.
create function public.nb_rename_result(value jsonb) returns jsonb
language sql immutable strict set search_path=pg_catalog,public,pg_temp as $$
  select case when value ? 'matches' then (value-'matches')||jsonb_build_object('games',value->'matches') else value end;
$$;
update public.nb_activity set
  before_data=public.nb_rename_result(before_data),after_data=public.nb_rename_result(after_data),
  action=case action when 'game.recorded' then 'match.recorded' when 'game.corrected' then 'match.corrected' else action end,
  description=case description when 'Recorded a game' then 'Recorded a match' else description end;
update public.nb_outbox set payload=(payload-'gameId')||jsonb_build_object('matchId',payload->'gameId') where payload ? 'gameId';
update public.nb_outbox set payload=jsonb_set(payload,'{before}',public.nb_rename_result(payload->'before')) where payload ? 'before';
update public.nb_outbox set payload=jsonb_set(payload,'{after}',public.nb_rename_result(payload->'after')) where payload ? 'after';
update public.nb_outbox set payload=jsonb_set(payload,'{action}',to_jsonb(case payload->>'action'
  when 'game.recorded' then 'match.recorded' else 'match.corrected' end))
  where payload->>'action' in ('game.recorded','game.corrected');
update public.nb_outbox set subject='A new match is on the board' where subject='A new game is on the board';
update public.nb_weekly_runs r set snapshot=(snapshot-'games')||jsonb_build_object('matches',(
  select coalesce(jsonb_agg(public.nb_rename_result(value) order by ord),'[]')
  from jsonb_array_elements(r.snapshot->'games') with ordinality items(value,ord))) where snapshot ? 'games';
update public.nb_daily_runs r set snapshot=(snapshot-'yesterdayGames')
  ||case when snapshot ? 'yesterdayGames' then jsonb_build_object('yesterdayMatches',snapshot->'yesterdayGames') else '{}'::jsonb end
  ||case when snapshot ? 'history' then jsonb_build_object('history',(
    select coalesce(jsonb_agg(case when value ? 'games' then (value-'games')||jsonb_build_object('matches',value->'games') else value end order by ord),'[]')
    from jsonb_array_elements(r.snapshot->'history') with ordinality items(value,ord))) else '{}'::jsonb end;
drop function public.nb_rename_result(jsonb);


create or replace function public.nb_mutate(p_token text,p_action text,p_match uuid,p_body jsonb,p_key text,p_fingerprint text)
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare s public.nb_sessions; g public.nb_matches; old_data jsonb; result jsonb := '{}';
  existing public.nb_requests; event uuid := gen_random_uuid(); comment_id uuid;
  recipient uuid; mentioned uuid; description text; subject text; old_emoji text;
begin
  select * into s from public.nb_sessions where token_hash=p_token and revoked_at is null and expires_at>now() for share;
  if not found then return jsonb_build_object('error','Sign in to continue.','status',401); end if;
  if p_key is null or length(p_key) not between 1 and 128 then
    return jsonb_build_object('error','Provide an Idempotency-Key for writes.');
  end if;
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
    description := 'Recorded a match'; subject := 'A new match is on the board';
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
  insert into public.nb_activity(id,actor,match_id,action,description,agent,before_data,after_data)
    values(event,s.player_id,g.id,p_action,description,case when s.kind='agent' then s.label end,old_data,
      case when p_action in ('match.recorded','match.corrected') then jsonb_build_object('score1',g.score1,'score2',g.score2,'games',g.games,'notes',g.notes) end);
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

create or replace function public.nb_match_content(p_matches uuid[],p_player uuid)
returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object(
    'comments',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at,c.id)
      from public.nb_comments c where c.match_id=any(p_matches) and c.deleted_at is null),'[]'),
    'reactions',coalesce((select jsonb_agg(to_jsonb(r))
      from public.nb_reactions r where r.match_id=any(p_matches)),'[]'),
    'history',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc)
      from public.nb_activity a where a.match_id=any(p_matches) and a.action in ('match.recorded','match.corrected')),'[]'),
    'subscriptions',coalesce((select jsonb_agg(to_jsonb(s))
      from public.nb_subscriptions s where s.match_id=any(p_matches) and s.player_id=p_player),'[]'));
$$;

create or replace function public.nb_page_matches(p_player uuid default null,p_time timestamptz default null,p_id uuid default null)
returns setof public.nb_matches language sql set search_path=pg_catalog,public,pg_temp as $$
  select * from public.nb_matches
  where (p_player is null or p_player in (player1,player2))
    and (p_time is null or (created_at,id)<(p_time,p_id))
  order by created_at desc,id desc limit 100;
$$;

create or replace function public.nb_page_matches_played(p_player uuid default null,p_date date default null,p_time timestamptz default null,p_id uuid default null)
returns setof public.nb_matches language sql set search_path=pg_catalog,public,pg_temp as $$
  select * from public.nb_matches
  where (p_player is null or p_player in (player1,player2))
    and (p_date is null or (date,created_at,id)<(p_date,p_time,p_id))
  order by date desc,created_at desc,id desc limit 100;
$$;

create or replace function public.nb_standings() returns jsonb language sql stable set search_path = pg_catalog, public, pg_temp as $$
with periods(period,start_date) as (
  values ('all',date '0001-01-01'),
    ('month',date_trunc('month',now() at time zone 'Europe/London')::date),
    ('week',date_trunc('week',now() at time zone 'Europe/London')::date)
), sides as (
  select player1 id,player2 opponent,(score1>score2)::int win,date from public.nb_matches
  union all select player2,player1,(score2>score1)::int,date from public.nb_matches
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

create or replace function public.nb_queue_weekly_recap(p_now timestamptz default now())
returns integer language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare local_now timestamp := p_now at time zone 'Europe/London';
  monday date; deadline timestamptz; snapshot jsonb; event uuid; queued integer;
begin
  monday := date_trunc('week',local_now)::date;
  deadline := (monday+4+time '17:00') at time zone 'Europe/London';
  if p_now<deadline then monday:=monday-7; deadline:=(monday+4+time '17:00') at time zone 'Europe/London'; end if;
  -- Catch a brief outage without sending stale recaps or backfilling on launch.
  if p_now>=deadline+interval '24 hours' then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('nb-weekly-'||monday::text,0));
  if exists(select 1 from public.nb_weekly_runs where week_start=monday) then return 0; end if;
  select jsonb_build_object('weekStart',monday,'weekEnd',monday+4,
    'players',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'avatar',avatar,'color',color,'image',case when image_key is not null then '/api/v1/photos/'||id end) order by id) from public.nb_players),'[]'),
    'matches',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'player1',g.player1,'player2',g.player2,'date',g.date,
      'score1',coalesce((a.after_data->>'score1')::integer,g.score1),
      'score2',coalesce((a.after_data->>'score2')::integer,g.score2),
      'games',coalesce(a.after_data->'games',g.games)) order by g.date,g.created_at,g.id)
      from public.nb_matches g left join lateral (
        select after_data from public.nb_activity where match_id=g.id and action in ('match.recorded','match.corrected') and created_at<=deadline order by created_at desc,id desc limit 1
      ) a on true where g.date between monday and monday+4 and g.created_at<=deadline),'[]')) into snapshot;
  insert into public.nb_weekly_runs(week_start,cutoff,snapshot) values(monday,deadline,snapshot) returning event_id into event;
  if jsonb_array_length(snapshot->'matches')=0 then return 0; end if;
  insert into public.nb_outbox(event_id,recipient,subject,payload)
    select event,id,'This week at the table',jsonb_build_object('action','weekly.recap','weekStart',monday)
    from public.nb_players where weekly_recap and created_at<=deadline;
  get diagnostics queued=row_count;
  return queued;
end; $$;

create or replace function public.nb_daily_snapshot(p_now timestamptz default now())
returns jsonb language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare today date := (p_now at time zone 'Europe/London')::date;
  deadline timestamptz := (today+time '08:00') at time zone 'Europe/London';
  result jsonb; excluded_pairs jsonb;
begin
  if extract(isodow from today)>5 or p_now<deadline or p_now>=deadline+interval '2 hours' then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('nb-daily-'||today::text,0));
  if exists(select 1 from public.nb_daily_runs where day=today and queued_at is not null) then return null; end if;
  select coalesce(jsonb_agg(pair order by pair),'[]') into excluded_pairs from (
    select jsonb_build_array(least(player1,player2),greatest(player1,player2)) pair
      from public.nb_matches where date=today-1 and created_at<=deadline
    union
    select pair from public.nb_daily_runs r cross join lateral jsonb_array_elements(coalesce(r.snapshot->'pairs','[]')) pair
      where r.day=today-1 and r.queued_at is not null
  ) excluded;
  select snapshot into result from public.nb_daily_runs where day=today;
  if found then
    if not result ? 'excludedPairs' then
      update public.nb_daily_runs set snapshot=snapshot||jsonb_build_object('excludedPairs',excluded_pairs)
        where day=today and queued_at is null returning snapshot into result;
      if not found then return null; end if;
    end if;
    return result;
  end if;
  select jsonb_build_object('day',today,'cutoff',deadline,'excludedPairs',excluded_pairs,
    'players',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'avatar',avatar,'image',case when image_key is not null then '/api/v1/photos/'||id end) order by id) from public.nb_players where daily_matchups and created_at<=deadline),'[]'),
    'history',coalesce((select jsonb_agg(jsonb_build_object('player1',a,'player2',b,'matches',matches,'lastPlayed',last_played) order by a,b) from (
      select least(player1,player2) a,greatest(player1,player2) b,count(*) matches,max(date) last_played
      from public.nb_matches where date>=today-28 and date<today and created_at<=deadline group by 1,2
    ) h),'[]'),
    'yesterdayMatches',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,
      'player1',jsonb_build_object('id',p1.id,'name',p1.name,'avatar',p1.avatar,'image',case when p1.image_key is not null then '/api/v1/photos/'||p1.id end),
      'player2',jsonb_build_object('id',p2.id,'name',p2.name,'avatar',p2.avatar,'image',case when p2.image_key is not null then '/api/v1/photos/'||p2.id end),
      'score1',coalesce((a.after_data->>'score1')::integer,g.score1),
      'score2',coalesce((a.after_data->>'score2')::integer,g.score2)) order by g.created_at,g.id)
      from public.nb_matches g join public.nb_players p1 on p1.id=g.player1 join public.nb_players p2 on p2.id=g.player2
      left join lateral (
        select after_data from public.nb_activity where match_id=g.id and action in ('match.recorded','match.corrected') and created_at<=deadline order by created_at desc,id desc limit 1
      ) a on true where g.date=today-1 and g.created_at<=deadline),'[]')) into result;
  insert into public.nb_daily_runs(day,cutoff,snapshot) values(today,deadline,result);
  return result;
end; $$;

create or replace function public.nb_queue_daily_matchups(p_day date,p_pairs jsonb)
returns integer language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare run public.nb_daily_runs; n integer; queued integer; fallback_players jsonb;
begin
  select * into run from public.nb_daily_runs where day=p_day for update;
  if not found or run.queued_at is not null then return 0; end if;
  n:=jsonb_array_length(run.snapshot->'players');
  if jsonb_typeof(p_pairs) is distinct from 'array' then raise exception 'Invalid daily lineup'; end if;
  select coalesce(jsonb_agg(p->>'id'),'[]') into fallback_players from jsonb_array_elements(run.snapshot->'players') p
    where not exists(select 1 from jsonb_array_elements(run.snapshot->'players') other where other->>'id'<>p->>'id'
      and not exists(select 1 from jsonb_array_elements(coalesce(run.snapshot->'excludedPairs','[]')) blocked
        where blocked ? (p->>'id') and blocked ? (other->>'id')));
  -- A repeat is allowed only to connect a player who has no fresh options.
  if jsonb_array_length(p_pairs)>n
    or exists(select 1 from jsonb_array_elements(p_pairs) e where jsonb_typeof(e)<>'array' or jsonb_array_length(e)<>2 or e->>0>=e->>1)
    or (select count(*) from (select distinct value from jsonb_array_elements(p_pairs)) p)<>jsonb_array_length(p_pairs)
    or exists(select 1 from jsonb_array_elements(p_pairs) e cross join lateral jsonb_array_elements_text(e) id where not exists(select 1 from jsonb_array_elements(run.snapshot->'players') p where p->>'id'=id))
    or exists(select 1 from jsonb_array_elements(run.snapshot->'players') p where (select count(*) from jsonb_array_elements(p_pairs) e where e ? (p->>'id'))>2)
    or exists(select 1 from jsonb_array_elements(p_pairs) pair join jsonb_array_elements(coalesce(run.snapshot->'excludedPairs','[]')) blocked on pair=blocked
      where not exists(select 1 from jsonb_array_elements_text(fallback_players) id where pair ? id))
    then raise exception 'Invalid daily lineup'; end if;
  update public.nb_daily_runs set snapshot=jsonb_set(snapshot,'{pairs}',p_pairs),queued_at=now() where day=p_day;
  insert into public.nb_outbox(event_id,recipient,subject,payload)
    select run.event_id,(p->>'id')::uuid,'Your opponents for today',jsonb_build_object('action','daily.matchups','day',p_day)
    from jsonb_array_elements(run.snapshot->'players') p join public.nb_players current_player on current_player.id=(p->>'id')::uuid
    where current_player.daily_matchups and (exists(select 1 from jsonb_array_elements(p_pairs) pair where pair ? (p->>'id'))
      or jsonb_array_length(coalesce(run.snapshot->'yesterdayMatches','[]'))>0);
  get diagnostics queued=row_count;
  return queued;
end; $$;


revoke all on function public.nb_game_wins(jsonb,integer),public.nb_mutate(text,text,uuid,jsonb,text,text),
  public.nb_match_content(uuid[],uuid),public.nb_page_matches(uuid,timestamptz,uuid),
  public.nb_page_matches_played(uuid,date,timestamptz,uuid),public.nb_standings(),
  public.nb_queue_weekly_recap(timestamptz),public.nb_daily_snapshot(timestamptz),
  public.nb_queue_daily_matchups(date,jsonb) from public,anon,authenticated;
grant execute on function public.nb_game_wins(jsonb,integer),public.nb_mutate(text,text,uuid,jsonb,text,text),
  public.nb_match_content(uuid[],uuid),public.nb_page_matches(uuid,timestamptz,uuid),
  public.nb_page_matches_played(uuid,date,timestamptz,uuid),public.nb_standings(),
  public.nb_queue_weekly_recap(timestamptz),public.nb_daily_snapshot(timestamptz),
  public.nb_queue_daily_matchups(date,jsonb) to project_admin;
