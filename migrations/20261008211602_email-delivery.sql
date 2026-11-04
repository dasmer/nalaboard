create function public.bb_claim_emails()
returns setof public.bb_outbox language sql set search_path = pg_catalog, public, pg_temp as $$
  update public.bb_outbox set leased_until=now()+interval '5 minutes', attempts=attempts+1
  where id in (select id from public.bb_outbox where sent_at is null and next_attempt_at<=now()
    and (leased_until is null or leased_until<now()) and created_at>now()-interval '23 hours'
    order by created_at limit 20 for update skip locked) returning *;
$$;
revoke all on function public.bb_claim_emails() from public,anon,authenticated;
grant execute on function public.bb_claim_emails() to project_admin;
