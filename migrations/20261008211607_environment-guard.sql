create table public.bb_environment (
  singleton boolean primary key default true check(singleton),
  environment text not null check(environment in ('unconfigured','test','production'))
);
insert into public.bb_environment(environment) values('unconfigured');
alter table public.bb_environment enable row level security;
revoke all on public.bb_environment from public,anon,authenticated;
grant all on public.bb_environment to project_admin;

create function public.bb_sign_out(p_token text) returns jsonb language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare s public.bb_sessions;
begin
  select * into s from public.bb_sessions where token_hash=p_token and revoked_at is null and expires_at>now() for update;
  if not found then return jsonb_build_object('error','Session not found.','status',401); end if;
  update public.bb_sessions set revoked_at=now() where id=s.id;
  insert into public.bb_activity(actor,action,description,agent)
    values(s.player_id,'session.ended','Signed out',case when s.kind='agent' then s.label end);
  return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.bb_sign_out(text) from public,anon,authenticated;
grant execute on function public.bb_sign_out(text) to project_admin;
