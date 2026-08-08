/* Demo data lifted from the Dialtone mockup. Replaced by Supabase queries
   once the schema lands — the shapes here are the contract the UI expects. */

export type Outcome =
  | "order"
  | "booking"
  | "question"
  | "transferred"
  | "spam"
  | "abandoned";

export type Call = {
  id: string;
  from: string;
  city: string;
  time: string;
  rel: string;
  outcome: Outcome;
  length: string;
  result: string;
  costCents: number;
};

export type SoldOutItem = {
  id: string;
  name: string;
  until: string;
};

export type LiveCall = {
  from: string;
  city: string;
  doing: string;
  startedSecondsAgo: number;
};

export const LOCATION = {
  name: "Nonna Rosa",
  city: "Oakland",
  timezone: "America/Los_Angeles",
  fallbackHumanNumber: "(510) 555-0142",
};

export const CALLS: Call[] = [
  {
    id: "k1",
    from: "(510) 555-0119",
    city: "Oakland, CA",
    time: "7:42 PM",
    rel: "4 min ago",
    outcome: "order",
    length: "2:48",
    result: "Order #1043 · $61.00",
    costCents: 19,
  },
  {
    id: "k2",
    from: "(415) 555-0164",
    city: "San Francisco, CA",
    time: "7:31 PM",
    rel: "15 min ago",
    outcome: "booking",
    length: "1:36",
    result: "Table for 4 · 8:30 PM",
    costCents: 12,
  },
  {
    id: "k3",
    from: "(510) 555-0102",
    city: "Berkeley, CA",
    time: "7:19 PM",
    rel: "27 min ago",
    outcome: "transferred",
    length: "0:54",
    result: "Allergen question → Marco",
    costCents: 8,
  },
  {
    id: "k4",
    from: "(925) 555-0188",
    city: "Walnut Creek, CA",
    time: "7:04 PM",
    rel: "42 min ago",
    outcome: "question",
    length: "0:41",
    result: "Hours & parking",
    costCents: 6,
  },
  {
    id: "k5",
    from: "(510) 555-0143",
    city: "Alameda, CA",
    time: "6:58 PM",
    rel: "48 min ago",
    outcome: "order",
    length: "3:12",
    result: "Order #1042 · $48.00",
    costCents: 21,
  },
  {
    id: "k6",
    from: "(213) 555-0110",
    city: "Los Angeles, CA",
    time: "6:44 PM",
    rel: "1 hr ago",
    outcome: "spam",
    length: "0:11",
    result: "Auto-dialer, hung up",
    costCents: 2,
  },
  {
    id: "k7",
    from: "(510) 555-0126",
    city: "Oakland, CA",
    time: "6:30 PM",
    rel: "1 hr ago",
    outcome: "order",
    length: "2:05",
    result: "Order #1041 · $34.00",
    costCents: 14,
  },
];

export const SOLD_OUT: SoldOutItem[] = [
  { id: "i7", name: "Squid Ink Tonnarelli", until: "Out until close" },
  { id: "i12", name: "Bistecca, 32oz", until: "Back at close" },
];

export const LIVE_CALL: LiveCall = {
  from: "(510) 555-0177",
  city: "Oakland, CA",
  doing: "taking a pickup order",
  startedSecondsAgo: 74,
};

export const STATS = [
  { label: "Calls answered", value: "31", note: "vs 18 missed last Friday" },
  { label: "Orders taken", value: "12", note: "$486 through the agent" },
  { label: "Tables booked", value: "7", note: "43 covers" },
  { label: "Sent to a human", value: "3", note: "2 allergen, 1 complaint" },
  { label: "Call spend", value: "$3.94", note: "$0.13 average" },
];

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const OUTCOME_TAG: Record<Outcome, string> = {
  order: "tag tag-accent",
  booking: "tag tag-accent-2",
  question: "tag tag-neutral",
  transferred: "tag tag-outline",
  spam: "tag tag-neutral",
  abandoned: "tag tag-neutral",
};
