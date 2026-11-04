drop function public.nb_claim_emails();
create function public.nb_claim_emails(p_event uuid default null)
returns setof public.nb_outbox language sql set search_path = pg_catalog, public, pg_temp as $$
  update public.nb_outbox set leased_until=now()+interval '5 minutes',attempts=attempts+1
  where id in (select id from public.nb_outbox where sent_at is null and next_attempt_at<=now()
    and (leased_until is null or leased_until<now()) and created_at>now()-interval '23 hours'
    and (p_event is null or event_id=p_event)
    order by created_at limit 20 for update skip locked) returning *;
$$;
revoke all on function public.nb_claim_emails(uuid) from public,anon,authenticated;
grant execute on function public.nb_claim_emails(uuid) to project_admin;
