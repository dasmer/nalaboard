-- Burntboard owns authentication. Only the trusted app server accesses these
-- tables; InsForge's anon/authenticated roles never receive business data.
create table public.bb_players (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and email ~ '^[^@[:space:]]+@(useallowance\.com|getburnt\.ai)$'),
  name text not null check (length(name) between 1 and 80),
  username text not null unique check (username ~ '^[a-z0-9_]{2,24}$'),
  bio text not null default '' check (length(bio) <= 240),
  avatar text not null default '🏓',
  color text not null default '#739783' check (color ~ '^#[0-9a-fA-F]{6}$'),
  image_key text,
  notifications boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.bb_otp (
  email text primary key,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  requested_at timestamptz not null default now(),
  consumed_at timestamptz
);
create table public.bb_rate_limits (
  key text primary key,
  count integer not null default 1,
  window_start timestamptz not null default now()
);
create table public.bb_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.bb_players(id),
  token_hash text not null unique,
  kind text not null check (kind in ('web', 'agent')),
  label text not null default 'Browser',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index bb_sessions_player on public.bb_sessions(player_id);
-- Completed best-of-three games only; reject extra matches after a sweep.
create function public.bb_series_wins(matches jsonb, side integer) returns integer
language plpgsql immutable strict set search_path=pg_catalog,public,pg_temp as $$
declare m jsonb; a integer; b integer; wins1 integer:=0; wins2 integer:=0;
begin
  if jsonb_typeof(matches)<>'array' then return null; end if;
  if jsonb_array_length(matches) not between 2 and 3 then return null; end if;
  for m in select value from jsonb_array_elements(matches) loop
    if wins1=2 or wins2=2 then return null; end if;
    if jsonb_typeof(m->'score1') is distinct from 'number' or jsonb_typeof(m->'score2') is distinct from 'number'
      or coalesce(m->>'score1','') !~ '^[0-9]{1,2}$' or coalesce(m->>'score2','') !~ '^[0-9]{1,2}$' then return null; end if;
    a:=(m->>'score1')::integer; b:=(m->>'score2')::integer;
    if not ((greatest(a,b)=11 and least(a,b)<=9) or (greatest(a,b)>=12 and abs(a-b)=2)) then return null; end if;
    if a>b then wins1:=wins1+1; else wins2:=wins2+1; end if;
  end loop;
  if greatest(wins1,wins2)<>2 then return null; end if;
  return case when side=1 then wins1 else wins2 end;
end; $$;
revoke all on function public.bb_series_wins(jsonb,integer) from public,anon,authenticated;
grant execute on function public.bb_series_wins(jsonb,integer) to project_admin;
create table public.bb_games (
  id uuid primary key default gen_random_uuid(),
  player1 uuid not null references public.bb_players(id),
  player2 uuid not null references public.bb_players(id),
  matches jsonb not null,
  score1 integer generated always as (public.bb_series_wins(matches,1)) stored not null,
  score2 integer generated always as (public.bb_series_wins(matches,2)) stored not null,
  date date not null,
  notes text not null default '' check (length(notes) <= 240),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  check (player1 <> player2)
);
create index bb_games_date on public.bb_games(date desc, created_at desc);
create table public.bb_comments (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.bb_games(id),
  player_id uuid not null references public.bb_players(id),
  text text not null check (length(text) between 1 and 500),
  mentions uuid[] not null default '{}',
  agent text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index bb_comments_game on public.bb_comments(game_id, created_at);
create table public.bb_subscriptions (
  game_id uuid not null references public.bb_games(id),
  player_id uuid not null references public.bb_players(id),
  muted boolean not null default false,
  primary key(game_id, player_id)
);
create table public.bb_reactions (
  game_id uuid not null references public.bb_games(id),
  player_id uuid not null references public.bb_players(id),
  emoji text not null check (emoji in ('🔥','🏓','😂','👏','😤')),
  primary key(game_id, player_id)
);
create table public.bb_activity (
  id uuid primary key default gen_random_uuid(),
  actor uuid not null references public.bb_players(id),
  game_id uuid references public.bb_games(id),
  action text not null,
  description text not null,
  agent text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index bb_activity_game on public.bb_activity(game_id, created_at);
create table public.bb_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  recipient uuid not null references public.bb_players(id),
  subject text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  leased_until timestamptz,
  last_error text,
  unique(event_id, recipient)
);
create table public.bb_requests (
  player_id uuid not null references public.bb_players(id),
  key text not null,
  fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(player_id, key)
);
do $$ declare t text; begin
  foreach t in array array['bb_players','bb_otp','bb_rate_limits','bb_sessions','bb_games','bb_comments','bb_subscriptions','bb_reactions','bb_activity','bb_outbox','bb_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to project_admin', t);
  end loop;
end $$;
