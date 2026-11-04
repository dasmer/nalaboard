create function public.bb_request_otp(p_email text, p_hash text, p_ip text)
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare bucket public.bb_rate_limits; challenge public.bb_otp; k text;
begin
  if p_email !~ '^[^@[:space:]]+@(useallowance\.com|getburnt\.ai)$' then
    return jsonb_build_object('error','Use your Burnt or Allowance email.','status',400);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_email,0));
  foreach k in array array['otp:email:'||p_email,'otp:ip:'||p_ip] loop
    insert into public.bb_rate_limits(key) values(k) on conflict do nothing;
    select * into bucket from public.bb_rate_limits where key=k for update;
    if bucket.window_start < now()-interval '1 hour' then
      update public.bb_rate_limits set count=1,window_start=now() where key=k;
    elsif bucket.count >= (case when k like 'otp:ip:%' then 20 else 5 end) then
      return jsonb_build_object('error','Too many sign-in requests. Try again later.','status',429);
    else update public.bb_rate_limits set count=count+1 where key=k;
    end if;
  end loop;
  select * into challenge from public.bb_otp where email=p_email;
  if challenge.requested_at > now()-interval '60 seconds' then
    return jsonb_build_object('error','Wait a minute before requesting another code.','status',429);
  end if;
  insert into public.bb_otp(email,code_hash,expires_at) values(p_email,p_hash,now()+interval '10 minutes')
  on conflict(email) do update set code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at,requested_at=now(),consumed_at=null;
  return jsonb_build_object('email',p_email);
end; $$;

create function public.bb_verify_otp(p_email text,p_hash text,p_token_hash text,p_kind text default 'web')
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare challenge public.bb_otp; person public.bb_players; fresh boolean := false; handle text;
begin
  if p_kind not in ('web','agent') then return jsonb_build_object('error','Invalid session kind.'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_email,0));
  select * into challenge from public.bb_otp where email=p_email for update;
  if not found or challenge.consumed_at is not null or challenge.expires_at <= now() or challenge.attempts >= 3 then
    return jsonb_build_object('error','Request a new sign-in code.','status',401);
  end if;
  if challenge.code_hash <> p_hash then
    update public.bb_otp set attempts=attempts+1 where email=p_email;
    return jsonb_build_object('error','That code is incorrect.','status',401);
  end if;
  update public.bb_otp set consumed_at=now() where email=p_email;
  select * into person from public.bb_players where email=p_email;
  if not found then
    fresh := true;
    handle := left(regexp_replace(split_part(p_email,'@',1),'[^a-z0-9_]','','g'),14);
    if length(handle)<2 then handle:='player'; end if;
    handle := handle || '_' || substr(replace(gen_random_uuid()::text,'-',''),1,8);
    insert into public.bb_players(email,name,username) values(p_email,split_part(p_email,'@',1),handle) returning * into person;
  end if;
  insert into public.bb_sessions(player_id,token_hash,kind,label,expires_at)
  values(person.id,p_token_hash,p_kind,case when p_kind='web' then 'Browser' else 'Agent login' end,
    now()+case when p_kind='web' then interval '30 days' else interval '90 days' end);
  return jsonb_build_object('isNew',fresh,'playerId',person.id);
end; $$;
revoke all on function public.bb_request_otp(text,text,text) from public,anon,authenticated;
revoke all on function public.bb_verify_otp(text,text,text,text) from public,anon,authenticated;
grant execute on function public.bb_request_otp(text,text,text) to project_admin;
grant execute on function public.bb_verify_otp(text,text,text,text) to project_admin;
