-- Accept one completed match as a single game; retain best-of-three validation.
-- Existing stored scores and audit history are unchanged; no backfill is needed.
create or replace function public.nb_series_wins(matches jsonb, side integer) returns integer
language plpgsql immutable strict set search_path=pg_catalog,public,pg_temp as $$
declare m jsonb; a integer; b integer; wins1 integer:=0; wins2 integer:=0;
begin
  if jsonb_typeof(matches)<>'array' then return null; end if;
  if jsonb_array_length(matches) not between 1 and 3 then return null; end if;
  for m in select value from jsonb_array_elements(matches) loop
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
  if greatest(wins1,wins2)<>(case when jsonb_array_length(matches)=1 then 1 else 2 end) then return null; end if;
  return case when side=1 then wins1 else wins2 end;
end; $$;
revoke all on function public.nb_series_wins(jsonb,integer) from public,anon,authenticated;
grant execute on function public.nb_series_wins(jsonb,integer) to project_admin;
