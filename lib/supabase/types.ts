/* Hand-written subset of the database types for the tables this app
   touches. Once the Supabase CLI is available, replace this file with:

     supabase gen types typescript --local > lib/supabase/types.ts

   Keep it in step with supabase/migrations until then. */

export type SoldOutUntil = "reopen" | "close";

export type CallStatus =
  | "ringing"
  | "in_progress"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed";

export type CallOutcome =
  | "order"
  | "booking"
  | "question"
  | "transferred"
  | "spam"
  | "abandoned";

export type OrderStatus =
  | "new"
  | "confirmed"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled";

export type LocationRow = {
  id: string;
  org_id: string;
  name: string;
  timezone: string;
  address: string | null;
  business_phone: string | null;
  twilio_number: string | null;
  fallback_human_number: string | null;
  greeting_text: string;
  greeting_audio_path: string | null;
  recording_enabled: boolean;
  recording_retention_days: number;
  is_live: boolean;
  kill_switch_on: boolean;
  order_delivery: "sms" | "email" | "both";
  order_sms_to: string | null;
  order_email_to: string | null;
  carrier_name: string | null;
  forwarding_verified_at: string | null;
  agent_secret_hash: string | null;
  tax_rate_bps: number;
  seats: number;
  reservation_slot_minutes: number;
  max_party_size: number;
  order_types: "pickup" | "delivery" | "both";
  pickup_promise_minutes: number;
  delivery_promise_minutes: number;
};

export type MenuCategoryRow = {
  id: string;
  location_id: string;
  name: string;
  sort_order: number;
  created_at: string;
};

export type MenuItemRow = {
  id: string;
  category_id: string;
  location_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  sold_out_until: SoldOutUntil | null;
  allergen_note: string | null;
  sort_order: number;
  updated_at: string;
};

export type CallRow = {
  id: string;
  location_id: string;
  twilio_call_sid: string;
  from_number: string | null;
  from_city: string | null;
  from_state: string | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  transferred_to_human: boolean;
  transfer_reason: string | null;
  is_spam: boolean;
  telephony_cost_cents: number;
  llm_cost_cents: number;
};

export type OrderRow = {
  id: string;
  location_id: string;
  call_id: string | null;
  order_number: number;
  customer_name: string | null;
  customer_phone: string | null;
  type: "pickup" | "delivery";
  status: OrderStatus;
  total_cents: number;
  placed_at: string;
};

export type BookingRow = {
  id: string;
  location_id: string;
  call_id: string | null;
  customer_name: string | null;
  party_size: number;
  requested_at: string;
  status: string;
};

/** A message taken for the restaurant during a call, because transfers
 *  are now only for catering and allergy questions
 *  (supabase/migrations/20260812000900_messages.sql). `body` is already
 *  redacted and length-bounded by the time it is written -- see
 *  lib/agent/messages.ts -- so nothing that reads this row has to scrub
 *  it again. `handled_at` is non-null exactly when `handled` is true; the
 *  table has a check constraint saying so. */
export type MessageRow = {
  id: string;
  location_id: string;
  call_id: string | null;
  caller_name: string | null;
  callback_phone: string | null;
  body: string;
  taken_at: string;
  handled: boolean;
  handled_at: string | null;
};

export type OrderItemRow = {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  name_snapshot: string;
  price_cents_snapshot: number;
  quantity: number;
  modifiers: unknown;
};
