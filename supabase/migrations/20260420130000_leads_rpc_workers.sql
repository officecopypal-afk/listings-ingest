-- ============================================================
-- Worker RPCs: wszystko przez public.* żeby nie zależeć od
-- exposed schemas (Supabase domyślnie exposuje tylko public).
-- ============================================================

create or replace function public.leads_get_active_jobs(p_portal text default 'otodom')
returns setof leads.scrape_jobs
language sql security definer set search_path = leads, public as $$
  select * from leads.scrape_jobs where active = true and portal = p_portal;
$$;

create or replace function public.leads_start_run(p_job_id bigint)
returns bigint
language plpgsql security definer set search_path = leads, public as $$
declare v_run_id bigint;
begin
  insert into leads.scrape_runs (scrape_job_id, status)
    values (p_job_id, 'running')
    returning id into v_run_id;
  return v_run_id;
end $$;

create or replace function public.leads_finalize_run(
  p_run_id bigint,
  p_job_id bigint,
  p_status text,
  p_pages int,
  p_listings_found int,
  p_listings_new int,
  p_phones_new int,
  p_error text default null
) returns void
language plpgsql security definer set search_path = leads, public as $$
begin
  update leads.scrape_runs set
    status          = p_status,
    finished_at     = now(),
    pages_scraped   = p_pages,
    listings_found  = p_listings_found,
    listings_new    = p_listings_new,
    phones_new      = p_phones_new,
    error           = p_error
  where id = p_run_id;

  update leads.scrape_jobs set
    last_run_at          = now(),
    last_run_status      = p_status,
    last_run_error       = p_error,
    last_run_new_phones  = p_phones_new,
    last_run_new_listings= p_listings_new
  where id = p_job_id;
end $$;

grant execute on function public.leads_get_active_jobs(text) to service_role, authenticated;
grant execute on function public.leads_start_run(bigint) to service_role;
grant execute on function public.leads_finalize_run(bigint, bigint, text, int, int, int, int, text) to service_role;
