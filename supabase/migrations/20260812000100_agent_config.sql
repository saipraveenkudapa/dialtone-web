-- Everything the voice agent needs that the schema did not yet hold.

alter table locations
  -- Per-location shared secret for the tool endpoints, stored as a
  -- SHA-256 hash. A leaked database dump must not yield a working key,
  -- and one restaurant's secret must never open another's tools.
  add column agent_secret_hash text,
  -- Sales tax in basis points (875 = 8.75%), so totals stay integer.
  add column tax_rate_bps integer not null default 0
    check (tax_rate_bps between 0 and 2000),
  add column seats integer not null default 40 check (seats > 0),
  add column reservation_slot_minutes integer not null default 90
    check (reservation_slot_minutes between 30 and 240),
  add column max_party_size integer not null default 8
    check (max_party_size between 1 and 40),
  add column order_types text not null default 'pickup'
    check (order_types in ('pickup', 'delivery', 'both'));

-- Vapi's own call id, so a tool call can find the call row we created
-- from the Twilio webhook.
alter table calls
  add column provider_call_id text;

create unique index calls_provider_call_id_idx
  on calls (provider_call_id)
  where provider_call_id is not null;

-- The reservation capacity query reads by location and time window.
create index bookings_location_requested_idx
  on bookings (location_id, requested_at)
  where status in ('requested', 'confirmed', 'seated');
