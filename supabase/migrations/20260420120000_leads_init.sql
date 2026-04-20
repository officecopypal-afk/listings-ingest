-- ============================================================
-- leads schema: scraper ingest + SMS pipeline
-- Kategorie: (property_type, transaction_type):
--   (mieszkanie, sprzedaz)  prio 20
--   (mieszkanie, wynajem)   prio 10
--   (dom,        sprzedaz)  prio 40
--   (dom,        wynajem)   prio 30
-- ============================================================
create schema if not exists leads;

grant usage on schema leads to authenticated, service_role;
alter default privileges in schema leads grant select on tables to authenticated;
alter default privileges in schema leads grant all on tables to service_role;
alter default privileges in schema leads grant all on sequences to service_role;
alter default privileges in schema leads grant execute on functions to authenticated, service_role;

-- ------------------------------------------------------------
-- phones
-- ------------------------------------------------------------
create table leads.phones (
  id bigserial primary key,
  phone_normalized text not null unique,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  sources jsonb not null default '[]'::jsonb,
  dnc boolean not null default false,
  dnc_reason text,
  dnc_at timestamptz
);
create index phones_dnc_idx on leads.phones(dnc) where dnc = true;

-- ------------------------------------------------------------
-- listings
-- ------------------------------------------------------------
create table leads.listings (
  id bigserial primary key,
  url text not null unique,
  portal text not null default 'otodom',
  portal_listing_id text,
  property_type text not null check (property_type in ('mieszkanie','dom','lokal')),
  transaction_type text not null check (transaction_type in ('sprzedaz','wynajem')),
  title text,
  price numeric,
  currency text default 'PLN',
  area_m2 numeric,
  rooms smallint,
  city text,
  district text,
  voivodeship text,
  owner_type text,
  posted_at timestamptz,
  first_scraped_at timestamptz not null default now(),
  last_scraped_at timestamptz not null default now(),
  phone_id bigint references leads.phones(id) on delete set null,
  raw jsonb
);
create index listings_phone_id_idx on leads.listings(phone_id);
create index listings_category_idx on leads.listings(property_type, transaction_type);
create index listings_posted_at_idx on leads.listings(posted_at desc);

-- ------------------------------------------------------------
-- scrape_jobs + scrape_runs
-- ------------------------------------------------------------
create table leads.scrape_jobs (
  id bigserial primary key,
  name text not null,
  portal text not null default 'otodom',
  property_type text not null,
  transaction_type text not null,
  search_url text not null,
  active boolean not null default true,
  last_run_at timestamptz,
  last_run_status text,
  last_run_error text,
  last_run_new_phones integer default 0,
  last_run_new_listings integer default 0,
  created_at timestamptz not null default now()
);

create table leads.scrape_runs (
  id bigserial primary key,
  scrape_job_id bigint references leads.scrape_jobs(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text,
  pages_scraped integer default 0,
  listings_found integer default 0,
  listings_new integer default 0,
  phones_new integer default 0,
  error text
);
create index scrape_runs_job_idx on leads.scrape_runs(scrape_job_id, started_at desc);

-- ------------------------------------------------------------
-- sms_templates
-- ------------------------------------------------------------
create table leads.sms_templates (
  id bigserial primary key,
  name text not null,
  property_type text not null,
  transaction_type text not null,
  priority smallint not null default 0,
  body text not null,
  sender_name text,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique(property_type, transaction_type)
);

-- ------------------------------------------------------------
-- sms_queue + sms_deliveries
-- ------------------------------------------------------------
create table leads.sms_queue (
  id bigserial primary key,
  phone_id bigint not null references leads.phones(id) on delete cascade,
  listing_id bigint references leads.listings(id) on delete set null,
  template_id bigint references leads.sms_templates(id),
  property_type text,
  transaction_type text,
  body text not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_msg_id text,
  error text,
  retry_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index sms_queue_pending_idx on leads.sms_queue(scheduled_at) where status = 'pending';
create index sms_queue_phone_idx on leads.sms_queue(phone_id, created_at desc);

create table leads.sms_deliveries (
  id bigserial primary key,
  sms_queue_id bigint references leads.sms_queue(id) on delete cascade,
  provider_msg_id text,
  event text,
  event_at timestamptz not null default now(),
  raw jsonb
);

-- ------------------------------------------------------------
-- Render template body: {{city}} {{price}} {{rooms}} {{area}} {{title}}
-- ------------------------------------------------------------
create or replace function leads.render_template(p_body text, p_listing leads.listings)
returns text language plpgsql immutable as $$
declare v_out text := p_body;
begin
  v_out := replace(v_out, '{{city}}',   coalesce(p_listing.city, ''));
  v_out := replace(v_out, '{{price}}',  coalesce(p_listing.price::text, ''));
  v_out := replace(v_out, '{{rooms}}',  coalesce(p_listing.rooms::text, ''));
  v_out := replace(v_out, '{{area}}',   coalesce(p_listing.area_m2::text, ''));
  v_out := replace(v_out, '{{title}}',  coalesce(p_listing.title, ''));
  return v_out;
end $$;

-- ------------------------------------------------------------
-- enqueue_sms: 90-day dedup + priority upgrade
-- ------------------------------------------------------------
create or replace function leads.enqueue_sms(
  p_phone_id bigint,
  p_listing_id bigint,
  p_property_type text,
  p_transaction_type text
) returns text language plpgsql as $$
declare
  v_tpl            leads.sms_templates%rowtype;
  v_pending        leads.sms_queue%rowtype;
  v_listing        leads.listings%rowtype;
  v_last_sent_at   timestamptz;
  v_pending_prio   smallint;
  v_body           text;
begin
  -- DNC?
  if exists(select 1 from leads.phones where id = p_phone_id and dnc = true) then
    return 'skipped_dnc';
  end if;

  -- template dla kategorii?
  select * into v_tpl from leads.sms_templates
    where property_type = p_property_type
      and transaction_type = p_transaction_type
      and active = true;
  if v_tpl.id is null then
    return 'skipped_no_template';
  end if;

  -- 90-dniowy dedup: czy coś wysłane w ostatnich 90d?
  select max(sent_at) into v_last_sent_at from leads.sms_queue
    where phone_id = p_phone_id and status = 'sent'
      and sent_at > now() - interval '90 days';
  if v_last_sent_at is not null then
    return 'skipped_within_90d';
  end if;

  select * into v_listing from leads.listings where id = p_listing_id;
  v_body := leads.render_template(v_tpl.body, v_listing);

  -- pending? upgrade tylko gdy nowy priorytet wyższy
  select * into v_pending from leads.sms_queue
    where phone_id = p_phone_id and status = 'pending'
    order by created_at desc limit 1;

  if v_pending.id is not null then
    select priority into v_pending_prio from leads.sms_templates where id = v_pending.template_id;
    if v_tpl.priority > coalesce(v_pending_prio, 0) then
      update leads.sms_queue set
        template_id      = v_tpl.id,
        listing_id       = p_listing_id,
        property_type    = p_property_type,
        transaction_type = p_transaction_type,
        body             = v_body
      where id = v_pending.id;
      return 'upgraded_to_higher_priority';
    end if;
    return 'skipped_lower_priority';
  end if;

  insert into leads.sms_queue (phone_id, listing_id, template_id, property_type, transaction_type, body)
    values (p_phone_id, p_listing_id, v_tpl.id, p_property_type, p_transaction_type, v_body);
  return 'queued';
end $$;

-- ------------------------------------------------------------
-- RPC: leads_ingest_offer — atomic upsert phone + listing + enqueue
-- ------------------------------------------------------------
create or replace function public.leads_ingest_offer(p_offer jsonb)
returns jsonb language plpgsql security definer set search_path = leads, public as $$
declare
  v_phone_id         bigint;
  v_phone_is_new     boolean := false;
  v_listing_id       bigint;
  v_listing_is_new   boolean := false;
  v_existing_phone   leads.phones%rowtype;
  v_sms_status       text := 'skipped_no_phone';
  v_portal           text := coalesce(p_offer->>'portal', 'otodom');
  v_phone_norm       text := p_offer->>'phone';
  v_property_type    text := p_offer->>'property_type';
  v_transaction_type text := p_offer->>'transaction_type';
begin
  -- phone (opcjonalne)
  if v_phone_norm is not null and v_phone_norm <> '' then
    select * into v_existing_phone from leads.phones where phone_normalized = v_phone_norm;
    if v_existing_phone.id is null then
      insert into leads.phones (phone_normalized, sources)
        values (v_phone_norm, jsonb_build_array(v_portal))
        returning id into v_phone_id;
      v_phone_is_new := true;
    else
      v_phone_id := v_existing_phone.id;
      update leads.phones set
        last_seen_at = now(),
        sources = case
          when sources ? v_portal then sources
          else sources || to_jsonb(v_portal)
        end
      where id = v_phone_id;
    end if;
  end if;

  -- listing (upsert po url)
  insert into leads.listings (
    url, portal, portal_listing_id, property_type, transaction_type, title, price, currency,
    area_m2, rooms, city, district, voivodeship, owner_type, posted_at, phone_id, raw
  ) values (
    p_offer->>'url',
    v_portal,
    p_offer->>'portal_listing_id',
    v_property_type,
    v_transaction_type,
    p_offer->>'title',
    nullif(p_offer->>'price','')::numeric,
    coalesce(p_offer->>'currency','PLN'),
    nullif(p_offer->>'area_m2','')::numeric,
    nullif(p_offer->>'rooms','')::smallint,
    p_offer->>'city',
    p_offer->>'district',
    p_offer->>'voivodeship',
    p_offer->>'owner_type',
    nullif(p_offer->>'posted_at','')::timestamptz,
    v_phone_id,
    p_offer->'raw'
  )
  on conflict (url) do update set
    last_scraped_at = now(),
    phone_id = coalesce(excluded.phone_id, leads.listings.phone_id),
    price = coalesce(excluded.price, leads.listings.price),
    title = coalesce(excluded.title, leads.listings.title)
  returning id, (xmax = 0) into v_listing_id, v_listing_is_new;

  if v_phone_id is not null then
    v_sms_status := leads.enqueue_sms(v_phone_id, v_listing_id, v_property_type, v_transaction_type);
  end if;

  return jsonb_build_object(
    'phone_id', v_phone_id,
    'phone_is_new', v_phone_is_new,
    'listing_id', v_listing_id,
    'listing_is_new', v_listing_is_new,
    'sms_status', v_sms_status
  );
end $$;

grant execute on function public.leads_ingest_offer(jsonb) to service_role;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table leads.phones          enable row level security;
alter table leads.listings        enable row level security;
alter table leads.scrape_jobs     enable row level security;
alter table leads.scrape_runs     enable row level security;
alter table leads.sms_templates   enable row level security;
alter table leads.sms_queue       enable row level security;
alter table leads.sms_deliveries  enable row level security;

create policy "auth read phones"       on leads.phones          for select to authenticated using (true);
create policy "auth read listings"     on leads.listings        for select to authenticated using (true);
create policy "auth all scrape_jobs"   on leads.scrape_jobs     for all    to authenticated using (true) with check (true);
create policy "auth read scrape_runs"  on leads.scrape_runs     for select to authenticated using (true);
create policy "auth all templates"     on leads.sms_templates   for all    to authenticated using (true) with check (true);
create policy "auth read queue"        on leads.sms_queue       for select to authenticated using (true);
create policy "auth read deliveries"   on leads.sms_deliveries  for select to authenticated using (true);

-- ------------------------------------------------------------
-- Seed: scrape_jobs (4 kategorie — mieszkania/domy × sprzedaz/wynajem)
-- ------------------------------------------------------------
insert into leads.scrape_jobs (name, property_type, transaction_type, search_url) values
 ('Otodom: mieszkania sprzedaz PL', 'mieszkanie', 'sprzedaz',
  'https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/cala-polska?limit=36&ownerTypeSingleSelect=PRIVATE&daysSinceCreated=1&by=LATEST&direction=DESC'),
 ('Otodom: domy sprzedaz PL', 'dom', 'sprzedaz',
  'https://www.otodom.pl/pl/wyniki/sprzedaz/dom/cala-polska?limit=36&ownerTypeSingleSelect=PRIVATE&daysSinceCreated=1&by=LATEST&direction=DESC'),
 ('Otodom: mieszkania wynajem PL', 'mieszkanie', 'wynajem',
  'https://www.otodom.pl/pl/wyniki/wynajem/mieszkanie/cala-polska?daysSinceCreated=1&extras=%5BIS_PRIVATE_OWNER%5D&by=LATEST&direction=DESC'),
 ('Otodom: domy wynajem PL', 'dom', 'wynajem',
  'https://www.otodom.pl/pl/wyniki/wynajem/dom/cala-polska?daysSinceCreated=1&extras=%5BIS_PRIVATE_OWNER%5D&by=LATEST&direction=DESC');

-- ------------------------------------------------------------
-- Seed: sms_templates (4 szablony, active=true — treści gotowe)
-- ------------------------------------------------------------
insert into leads.sms_templates (name, property_type, transaction_type, priority, body, sender_name, active) values
 ('Dom sprzedaz', 'dom', 'sprzedaz', 40,
  $$Dzien dobry, kontaktuje sie w sprawie sprzedazy domu. Przypominam, ze przy transakcji notariusz wymaga swiadectwa energetycznego. Jesli jeszcze go Pan/Pani nie posiada - wykonuje je zdalnie, w cenie od 329 zl. Prosze o SMS o tresci TAK (oddzwonie) lub kontakt pod nr: 573580430.$$,
  'Audyteko', true),
 ('Dom wynajem', 'dom', 'wynajem', 30,
  $$Dzien dobry, kontaktuje sie w sprawie wynajmu domu. Czy posiada Pan/Pani wymagane swiadectwo energetyczne? Jesli nie - wykonuje swiadectwa energetyczne, calosc realizowana zdalnie, w cenie od 329 zl Prosze o SMS TAK (oddzwonie) lub tel bezposrednio na nr: 573 580 480$$,
  'Audyteko', true),
 ('Mieszkanie sprzedaz', 'mieszkanie', 'sprzedaz', 20,
  $$Dzien dobry, kontaktuje sie w sprawie sprzedazy mieszkania. Przypominam, ze notariusz nie sfinalizuje umowy bez swiadectwa energetycznego. Jesli jeszcze go Pan/Pani nie posiada - przygotowuje dokumenty zdalnie (od 129 zl). Prosze o SMS o tresci TAK (oddzwonie) lub kontakt pod nr: nr: 573580430.$$,
  'Audyteko', true),
 ('Mieszkanie wynajem', 'mieszkanie', 'wynajem', 10,
  $$Dzien dobry, kontaktuje sie w sprawie ogloszenia. Przypominam, ze przy wynajmie wymagane jest swiadectwo energetyczne (obowiazek ustawowy). Jesli jeszcze go Pan/Pani nie posiada, chetnie pomoge - wykonuje je zdalnie, cena od 129 zl. Prosze o SMS o tresci TAK (oddzwonie) lub kontakt pod nr: 573580430.$$,
  'Audyteko', true);
