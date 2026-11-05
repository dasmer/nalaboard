-- Expand only the exact email domains; existing accounts and OTP safeguards stay intact.
alter table public.nb_players
  drop constraint nb_players_email_check,
  add constraint nb_players_email_check check (
    email = lower(email) and email ~ '^[^@[:space:]]+@(useallowance\.com|nala\.money|rafiki\.com)$'
  );

create or replace function public.nb_request_otp(p_email text, p_hash text, p_ip text)
returns jsonb language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare bucket public.nb_rate_limits; challenge public.nb_otp; k text;
begin
  if p_email !~ '^[^@[:space:]]+@(useallowance\.com|nala\.money|rafiki\.com)$' then
    return jsonb_build_object('error','Use your @nala.money, @rafiki.com, or @useallowance.com email.','status',400);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_email,0));
  foreach k in array array['otp:email:'||p_email,'otp:ip:'||p_ip] loop
    insert into public.nb_rate_limits(key) values(k) on conflict do nothing;
    select * into bucket from public.nb_rate_limits where key=k for update;
    if bucket.window_start < now()-interval '1 hour' then
      update public.nb_rate_limits set count=1,window_start=now() where key=k;
    elsif bucket.count >= (case when k like 'otp:ip:%' then 20 else 5 end) then
      return jsonb_build_object('error','Too many sign-in requests. Try again later.','status',429);
    else update public.nb_rate_limits set count=count+1 where key=k;
    end if;
  end loop;
  select * into challenge from public.nb_otp where email=p_email;
  if challenge.requested_at > now()-interval '60 seconds' then
    return jsonb_build_object('error','Wait a minute before requesting another code.','status',429);
  end if;
  insert into public.nb_otp(email,code_hash,expires_at) values(p_email,p_hash,now()+interval '10 minutes')
  on conflict(email) do update set code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at,requested_at=now(),consumed_at=null;
  return jsonb_build_object('email',p_email);
end; $$;
