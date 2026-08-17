# Agent Warmth and Pace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone agent speaks at a calmer pace and reacts warmly — at most twice a call — only to dishes the restaurant itself nominated.

**Architecture:** Three independent seams. Pace is two constants in the Vapi assistant payload. Staff picks are a boolean column capped at three by a database trigger, surfaced to the agent through the existing `get_menu` payload and suppressed when the dish is sold out. Warmth is a prompt rule that *replaces* two vague existing lines rather than adding a third.

**Tech Stack:** Next.js 16 (App Router, RSC + server actions), TypeScript, Supabase Postgres, Vitest, Vapi (assistant config), ElevenLabs `eleven_flash_v2_5`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-17-agent-warmth-and-pace-design.md`. Read it before Task 1.
- `AGENTS.md` governs all UI work: never hardcode a colour, spacing, radius, shadow or font-family — tokens only. Extend styling in `app/app.css` only.
- Money is integer cents. Timestamps are UTC in the DB, rendered in the location's timezone.
- Every exported mutation in `lib/admin/edit.ts` begins with `gate(locationId)`; the only caller-supplied ids are uuids validated before Postgres.
- No secret, key or password may reach a log line or a response body. PostgrestError text is never logged on an agent path — location id and SQLSTATE only.
- The allergy rule in `lib/agent/prompt.ts` and its sentence **"There are no exceptions to this."** must survive every edit in this plan, byte for byte.
- `lib/agent/prompt.test.ts` hash-pins the prompt. Re-blessing it is a deliberate, recorded act — see Task 4.
- Tool endpoints answer `{"results":[{toolCallId, result|error}]}` with **HTTP 200 on every path**. Do not regress this.
- Run from `/Users/saipraveen/Desktop/AI Calls Agent/dialtone-web`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/vapi/provision.ts` | `VOICE` gains `speed`; `START_SPEAKING_PLAN.waitSeconds` 0.6 → 0.8 | 1 |
| `lib/vapi/provision.test.ts` | pins both values in the built payload | 1 |
| `supabase/migrations/20260817000100_staff_picks.sql` | `is_staff_pick` column + 3-per-location trigger | 2 |
| `lib/supabase/types.ts` | `MenuItemRow.is_staff_pick: boolean` | 2 |
| `supabase/tests/rls_test.sql` | trigger assertions | 2 |
| `lib/agent/menu.ts` | `staff_pick` in the agent payload, suppressed when sold out | 3 |
| `lib/agent/menu.test.ts` | payload assertions | 3 |
| `lib/agent/prompt.ts` | the bounded warmth rule replacing two vague lines | 4 |
| `lib/agent/prompt.test.ts` | rule assertions + re-blessed hash | 4 |
| `lib/admin/edit.ts` | `MenuItemInput.staffPick`, validation, patch | 5 |
| `lib/admin/edit.test.ts` | validation + cap-refusal assertions | 5 |
| `components/admin/MenuAdmin.tsx` | the checkbox, disabled at three | 5 |

---

### Task 1: Pace defaults

**Files:**
- Modify: `lib/vapi/provision.ts:407` (`VOICE`) and `lib/vapi/provision.ts:418` (`waitSeconds`)
- Test: `lib/vapi/provision.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. `buildAssistantPayload()` output gains `voice.speed: 0.92` and `startSpeakingPlan.waitSeconds: 0.8`.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `lib/vapi/provision.test.ts`:

```ts
describe("pace", () => {
  it("speaks at 0.92 and waits 0.8s before answering", () => {
    const payload = buildAssistantPayload({
      location: locationFixture(),
      systemPrompt: "x",
      greeting: "y",
      base: "https://example.test",
      agentSecret: "s",
    }) as {
      voice: { speed: number };
      startSpeakingPlan: { waitSeconds: number };
    };

    // Chosen by ear against a real call, not by theory: below ~0.85 she
    // sounds sedated, and above ~1.2s of wait a phone line reads as dead
    // and callers say "hello? are you there?".
    expect(payload.voice.speed).toBe(0.92);
    expect(payload.startSpeakingPlan.waitSeconds).toBe(0.8);
  });
});
```

If `locationFixture()` does not exist in that file, reuse whatever fixture the neighbouring `buildAssistantPayload` tests already build — read the file and copy its call shape exactly rather than inventing arguments.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/vapi/provision.test.ts -t "speaks at 0.92"`
Expected: FAIL — `expected undefined to be 0.92`.

- [ ] **Step 3: Write minimal implementation**

`lib/vapi/provision.ts:407` — replace:

```ts
const VOICE = { provider: "11labs", voiceId: "sarah", model: "eleven_flash_v2_5" };
```

with:

```ts
const VOICE = {
  provider: "11labs",
  voiceId: "sarah",
  model: "eleven_flash_v2_5",
  // The product owner heard a real call as "too fast ... calm and a
  // little slow, not too slow". 1.0 is the ElevenLabs default and was
  // never set here. 0.92 is a starting value to tune by ear: below about
  // 0.85 she stops sounding calm and starts sounding sedated.
  speed: 0.92,
};
```

`lib/vapi/provision.ts:418` — replace `waitSeconds: 0.6,` with:

```ts
  // Raised from 0.6 with the same complaint in mind: a beat before she
  // answers reads as composure. Every 100ms here is dead air on every
  // turn of every call, so this moves in small steps and gets heard
  // before it moves again.
  waitSeconds: 0.8,
```

Keep the existing comment above `waitSeconds` — it explains why this is not Vapi's 0.4s default and is still true.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/vapi lib/provisioning`
Expected: PASS. If a neighbouring test snapshots the whole payload, update that expectation to include the two new values — it is pinning the same deliberate change.

- [ ] **Step 5: Commit**

```bash
git add lib/vapi/provision.ts lib/vapi/provision.test.ts
git commit -m "The agent stops rushing the caller"
```

---

### Task 2: `is_staff_pick`, capped at three by the database

**Files:**
- Create: `supabase/migrations/20260817000100_staff_picks.sql`
- Modify: `lib/supabase/types.ts` (`MenuItemRow`)
- Test: `supabase/tests/rls_test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `menu_items.is_staff_pick boolean not null default false`; `MenuItemRow.is_staff_pick: boolean`; trigger `menu_items_staff_pick_cap` raising SQLSTATE `23514` on the fourth pick.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260817000100_staff_picks.sql`:

```sql
-- Three dishes a restaurant stands behind, and the agent may say so.
--
-- The cap is here and not only in the form because a limit that exists
-- only in a form is not a limit. It is also the whole feature: an owner
-- who marks all 46 items gets an agent that compliments everything,
-- which is the grating version this exists to avoid.
alter table menu_items
  add column is_staff_pick boolean not null default false;

create or replace function app.enforce_staff_pick_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  picks integer;
begin
  -- Only a row that IS a pick can push a location over the line.
  if new.is_staff_pick is not true then
    return new;
  end if;

  -- Already counted: an edit to a row that was a pick before, and has
  -- not moved to another restaurant, changes no total.
  if tg_op = 'UPDATE'
     and old.is_staff_pick is true
     and old.location_id = new.location_id then
    return new;
  end if;

  select count(*) into picks
    from menu_items
   where location_id = new.location_id
     and is_staff_pick
     and id <> new.id;

  if picks >= 3 then
    raise exception
      'A restaurant can mark at most three staff picks.'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- Revoked from the tenant roles by name and granted to nobody: this runs
-- as a trigger, never as a call, and the house posture is that a
-- SECURITY DEFINER function is not also an API.
revoke all on function app.enforce_staff_pick_cap() from anon, authenticated;

create trigger menu_items_staff_pick_cap
  before insert or update on menu_items
  for each row execute function app.enforce_staff_pick_cap();

comment on column menu_items.is_staff_pick is
  'The restaurant nominated this dish. get_menu carries it to the agent, '
  'which may say once that it is the one people come back for. Capped at '
  'three per location by menu_items_staff_pick_cap. Suppressed in the '
  'agent payload while the item is sold out -- see lib/agent/menu.ts.';
```

- [ ] **Step 2: Add the trigger assertions to the RLS test**

In `supabase/tests/rls_test.sql`, immediately **before** the final `reset role;`, add:

```sql
-- ── staff pick cap ───────────────────────────────────────────────────
do $$
declare
  loc uuid := 'a10c0000-0000-0000-0000-00000000000a';
  cat uuid;
  ids uuid[];
begin
  select id into cat from menu_categories where location_id = loc limit 1;

  select array_agg(id) into ids
    from (select id from menu_items where location_id = loc limit 4) t;

  update menu_items set is_staff_pick = true where id = ids[1];
  update menu_items set is_staff_pick = true where id = ids[2];
  update menu_items set is_staff_pick = true where id = ids[3];
  insert into results values ('staff picks: three allowed', 'ok', 'ok');

  begin
    update menu_items set is_staff_pick = true where id = ids[4];
    insert into results values ('staff picks: fourth refused', 'allowed', 'refused');
  exception when check_violation then
    insert into results values ('staff picks: fourth refused', 'refused', 'refused');
  end;

  -- Unmarking frees a slot.
  update menu_items set is_staff_pick = false where id = ids[1];
  begin
    update menu_items set is_staff_pick = true where id = ids[4];
    insert into results values ('staff picks: unmarking frees a slot', 'ok', 'ok');
  exception when check_violation then
    insert into results values ('staff picks: unmarking frees a slot', 'refused', 'ok');
  end;

  -- A second restaurant is counted separately.
  begin
    update menu_items set is_staff_pick = true
     where location_id = 'd7be1400-7c38-4933-a248-407ff339cd73'
       and id = (select id from menu_items
                  where location_id = 'd7be1400-7c38-4933-a248-407ff339cd73' limit 1);
    insert into results values ('staff picks: counted per restaurant', 'ok', 'ok');
  exception when check_violation then
    insert into results values ('staff picks: counted per restaurant', 'refused', 'ok');
  end;
end $$;
```

- [ ] **Step 3: Add the column to the row type**

In `lib/supabase/types.ts`, inside `MenuItemRow`, after `sold_out_until`:

```ts
  /** The restaurant nominated this dish. Capped at three per location by
   *  a database trigger, not by the form. */
  is_staff_pick: boolean;
```

- [ ] **Step 4: Apply and verify**

Run:

```bash
supabase start && supabase db reset && psql "$DATABASE_URL" -f supabase/tests/rls_test.sql
```

Expected: every row reads **PASS**, including the four new `staff picks:` rows.

If Docker is unavailable on this machine, apply the migration to the remote project instead and verify by hand: mark three items, confirm the fourth is refused with SQLSTATE `23514`, then unmark one and confirm the fourth is accepted. Record in the commit message which route was used — an unverified trigger is the failure this task exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260817000100_staff_picks.sql supabase/tests/rls_test.sql lib/supabase/types.ts
git commit -m "A restaurant can nominate three dishes, and only three"
```

---

### Task 3: The agent hears a pick, and never hears a sold-out one

**Files:**
- Modify: `lib/agent/menu.ts` (`AgentMenuItem`, `shapeMenu`)
- Test: `lib/agent/menu.test.ts`

**Interfaces:**
- Consumes: `MenuItemRow.is_staff_pick` from Task 2.
- Produces: `AgentMenuItem.staff_pick?: true` — present only on a pick that is currently on offer, absent otherwise.

- [ ] **Step 1: Write the failing tests**

Append to `lib/agent/menu.test.ts`. Build items with the file's existing fixture helper; if it builds `MenuItemRow` literals inline, copy that shape and add `is_staff_pick`.

```ts
describe("staff picks in the agent payload", () => {
  it("marks a pick that is on offer", () => {
    const menu = shapeMenu([
      category("Pasta", [item({ name: "Bucatini", is_staff_pick: true })]),
    ]);
    expect(menu.categories[0].items[0].staff_pick).toBe(true);
  });

  it("leaves the key off an ordinary item entirely", () => {
    const menu = shapeMenu([
      category("Pasta", [item({ name: "Cacio e Pepe", is_staff_pick: false })]),
    ]);
    // Absent, not false: this payload is fetched on every call that
    // mentions food and sits in the latency budget.
    expect("staff_pick" in menu.categories[0].items[0]).toBe(false);
  });

  it("suppresses a pick that is sold out until reopen", () => {
    const menu = shapeMenu([
      category("Pasta", [
        item({ name: "Bucatini", is_staff_pick: true, sold_out_until: "reopen" }),
      ]),
    ]);
    // Praising a dish and refusing it in the same breath is worse than
    // saying nothing. The flag was set weeks ago; sold-out was set this
    // afternoon, and the fresher fact wins.
    expect("staff_pick" in menu.categories[0].items[0]).toBe(false);
    expect(menu.categories[0].items[0].sold_out).toBe(true);
  });

  it("suppresses a pick that is sold out until close", () => {
    const menu = shapeMenu([
      category("Pasta", [
        item({ name: "Bucatini", is_staff_pick: true, sold_out_until: "close" }),
      ]),
    ]);
    expect("staff_pick" in menu.categories[0].items[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agent/menu.test.ts -t "staff picks"`
Expected: FAIL — `expected undefined to be true`.

- [ ] **Step 3: Write minimal implementation**

In `lib/agent/menu.ts`, add to `AgentMenuItem` after `ingredients?: string;`:

```ts
  /** The restaurant nominated this dish, and the agent may say once that
   *  it is the one people come back for -- see the rule in
   *  lib/agent/prompt.ts, which caps it at twice a call.
   *
   *  Absent rather than `false` on ordinary items, for the same latency
   *  reason `ingredients` is, and absent on a pick that is SOLD OUT:
   *  praising a dish and then refusing it in the same breath is worse
   *  than saying nothing. Suppressing it here rather than in the prompt
   *  means the agent is never holding a contradiction it has to reason
   *  its way out of mid-call. */
  staff_pick?: true;
```

In `shapeMenu`, inside the item map, after `const ingredients = ...`:

```ts
      const isPick = item.is_staff_pick === true && !isOut;
```

and add to the returned object, after the `ingredients` spread:

```ts
        ...(isPick ? { staff_pick: true as const } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agent`
Expected: PASS, whole directory.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/menu.ts lib/agent/menu.test.ts
git commit -m "A sold-out favourite stops being a favourite"
```

---

### Task 4: The warmth rule, and a deliberate re-blessing

**Files:**
- Modify: `lib/agent/prompt.ts` (the line currently at `:11`, and the line currently at `:64`)
- Test: `lib/agent/prompt.test.ts`

**Interfaces:**
- Consumes: `AgentMenuItem.staff_pick` from Task 3 — the prompt refers to it by the name the payload uses.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing tests**

Append to the main `describe` in `lib/agent/prompt.test.ts`:

```ts
describe("warmth is earned, not generic", () => {
  it("ties the reaction to a staff pick and caps it", () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain("staff pick");
    expect(SYSTEM_PROMPT_TEMPLATE).toContain("the one people come back for");
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/at most twice/i);
  });

  it("never claims a preference it cannot have", () => {
    // She does not eat. The prompt already commits her to answering
    // truthfully when asked whether she is an AI, and a caller who hears
    // her name a favourite dish and then hears "I'm the automated
    // assistant" has caught her in something.
    expect(SYSTEM_PROMPT_TEMPLATE).not.toMatch(/my favou?rite/i);
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/never say a dish is your favou?rite/i);
  });

  it("drops the vague reaction lines it replaces", () => {
    // These lost to "Keep every reply short" for two months. Leaving
    // them in alongside the specific rule recreates the same contest.
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('A quick "nice" or "good choice" goes a long way');
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('React a little too');
  });

  it("still transfers every allergy without exception", () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain("There are no exceptions to this.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agent/prompt.test.ts -t "warmth is earned"`
Expected: FAIL on the first three; the allergy assertion passes already and must keep passing.

- [ ] **Step 3: Edit the prompt**

In `lib/agent/prompt.ts`, replace the line reading:

```
Thank them for calling, react to what they say instead of just moving to the next question, and use their name once you have it. A quick "nice" or "good choice" goes a long way.
```

with:

```
Thank them for calling, react to what they say instead of just moving to the next question, and use their name once you have it.
```

Replace the line reading:

```
Confirm each item as you add it. Short: "Got it, large pepperoni." React a little too - "nice" or "good choice" is plenty.
```

with:

```
Confirm each item as you add it. Short: "Got it, large pepperoni."

When get_menu marks an item as a staff pick, you may say once that it is the one people come back for. At most twice in a whole call, and only about an item get_menu marked - never about anything else on the menu. Never say a dish is your favourite, that you love it, or that you have tried it. You do not eat. Say nothing of the kind once an allergy has come up; that call is already transferring.
```

- [ ] **Step 4: Re-bless the hash, as a recorded act**

Run:

```bash
node -e 'const {SYSTEM_PROMPT_TEMPLATE}=require("./lib/agent/prompt.ts");' 2>/dev/null || \
npx vitest run lib/agent/prompt.test.ts -t "blessed hash"
```

The test failure prints the received hash. Copy it into the `expect(hash).toBe(...)` literal in `lib/agent/prompt.test.ts`, and **extend the comment block above that test** in the style already there — the file records every previous re-blessing and this must join them:

```ts
  // Re-blessed again, for the warmth rule, and this is that reviewed
  // record of it. The previous hash was
  // 529b3a8f9cb294080b93b6f4eac54876e115f4c5ecbe256200beb3155d841de1.
  // Two lines changed, both deliberately narrowing vague guidance that
  // had been losing to "Keep every reply short" since it was written:
  //     -... A quick "nice" or "good choice" goes a long way.
  //     -Confirm each item ... React a little too - "nice" or "good choice" is plenty.
  //     +Confirm each item ... (plus the staff-pick paragraph)
  // The allergy rule and its "There are no exceptions to this." are
  // untouched, and a test above asserts that independently of this hash.
```

- [ ] **Step 5: Run the whole agent suite**

Run: `npx vitest run lib/agent`
Expected: PASS. The character-count and latency-ceiling tests in this file may now fail — the prompt grew. If the ceiling is exceeded, do **not** raise it silently: report the new length and the ceiling and stop, because that ceiling exists to protect the 7.5s assistant-request budget.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/prompt.ts lib/agent/prompt.test.ts
git commit -m "She compliments the dish the restaurant chose, twice at most"
```

---

### Task 5: The operator marks the picks

**Files:**
- Modify: `lib/admin/edit.ts` (`MenuItemInput`, `MenuItemPatch`, `validateMenuItem`, `saveMenuItem`)
- Modify: `components/admin/MenuAdmin.tsx`
- Test: `lib/admin/edit.test.ts`

**Interfaces:**
- Consumes: `menu_items.is_staff_pick` and the trigger from Task 2.
- Produces: `MenuItemInput.staffPick: boolean`; `saveMenuItem` refuses the fourth pick with a spoken sentence rather than a Postgres error.

- [ ] **Step 1: Write the failing tests**

Append to `lib/admin/edit.test.ts`, matching the fake-PostgREST pattern already used in that file:

```ts
describe("staff picks", () => {
  it("carries the flag through to the write", async () => {
    const { writes } = await runSaveMenuItem({ staffPick: true });
    expect(writes.at(-1)?.patch.is_staff_pick).toBe(true);
  });

  it("turns the trigger's refusal into a sentence an operator can act on", async () => {
    // The trigger raises 23514. An operator must not be shown a Postgres
    // error, and must be told the actual rule.
    const result = await runSaveMenuItem({ staffPick: true }, { failWith: "23514" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/three/i);
    expect(result.error).not.toMatch(/23514|violates|constraint/i);
  });
});
```

Implement `runSaveMenuItem` as a thin wrapper over whatever harness the neighbouring `saveMenuItem` tests already use — read them first and reuse, do not build a second harness.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/admin/edit.test.ts -t "staff picks"`
Expected: FAIL — `staffPick` is not a property of `MenuItemInput`.

- [ ] **Step 3: Write minimal implementation**

In `lib/admin/edit.ts`, add to `MenuItemInput` after `soldOutUntil`:

```ts
  /** The restaurant nominated this dish. At most three per location,
   *  refused by a database trigger rather than by this form. */
  staffPick: boolean;
```

Add to `MenuItemPatch`:

```ts
  is_staff_pick: boolean;
```

In `validateMenuItem`, carry it into the validated value unchanged — it is already a boolean and needs no coercion. In `saveMenuItem`, include `is_staff_pick: value.staffPick` in the patch, and map the trigger's error before returning:

```ts
    // 23514 here is the staff-pick cap, the only check constraint this
    // write can violate. Anything else keeps the generic refusal.
    if (error?.code === "23514") {
      return refuse(
        "This restaurant already has three staff picks. Unmark one first.",
      );
    }
```

- [ ] **Step 4: Add the checkbox**

In `components/admin/MenuAdmin.tsx`, inside the item edit form, beside the sold-out control, add a checkbox bound to `staffPick`. Use the existing `.field` / label pattern in that file — read a neighbouring field and copy its structure exactly. It must be `disabled` when the location already has three picks and this item is not one of them, with a visible sentence saying why:

```tsx
{picksUsed >= 3 && !item.is_staff_pick ? (
  <p className="setup-note">
    Three dishes are already marked. Unmark one to choose another.
  </p>
) : null}
```

Derive `picksUsed` from the categories already in props — do not add a query.

- [ ] **Step 5: Run the gates**

Run: `npx tsc --noEmit && npm run lint && npx vitest run && npm run build`
Expected: all four exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/admin/edit.ts lib/admin/edit.test.ts components/admin/MenuAdmin.tsx
git commit -m "Three dishes, chosen by the people who cook them"
```

---

### Task 6: Push it to the phone and hear it

**Files:** none — this task changes the running system, not the repo.

**Interfaces:**
- Consumes: everything above.
- Produces: a re-pushed assistant per location, and a transcript to count.

- [ ] **Step 1: Mark three picks on a real restaurant**

In the console Menu tab, mark three dishes on Nonna Rosa. Confirm the fourth checkbox is refused with the sentence from Task 5, not a Postgres error.

- [ ] **Step 2: Re-push each assistant**

There are two locations today, so this is two commands. `AGENT_SECRET` carries the existing plaintext forward, so **the tool secret does not rotate** and no in-flight call 401s:

```bash
set -a && . ./.env.local && set +a
AGENT_SECRET="$AGENT_SECRET_NONNA_ROSA" node scripts/provision-vapi.mjs \
  a10c0000-0000-0000-0000-00000000000a https://dialtone-web.vercel.app --dry-run
```

Read the dry-run payload and confirm `voice.speed` is `0.92`, `startSpeakingPlan.waitSeconds` is `0.8`, and the staff-pick paragraph is in the system prompt. Then run it again without `--dry-run`.

- [ ] **Step 3: Verify the tool payload carries the picks**

```bash
curl -s -X POST https://dialtone-web.vercel.app/api/agent/menu \
  -H "content-type: application/json" \
  -H "x-dialtone-secret: $AGENT_SECRET_NONNA_ROSA" \
  -d '{"message":{"type":"tool-calls","toolCallList":[{"id":"t1","name":"get_menu","arguments":{}}]}}'
```

Expected: HTTP 200, `{"results":[{"toolCallId":"t1","result":"..."}]}`, and exactly three items carrying `staff_pick` — unless one is sold out, in which case fewer.

- [ ] **Step 4: Place a real call**

Order a staff pick and an ordinary item. Listen for pace and for whether she reacts.

- [ ] **Step 5: Count what actually happened**

The claim "she reacts" is countable, unlike pace. After the call:

```bash
node -e '
const {createClient}=require("@supabase/supabase-js");
const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
sb.from("calls").select("transcript").order("started_at",{ascending:false}).limit(1)
 .then(({data})=>{
   const lines=data[0].transcript?.lines||[];
   const hits=lines.filter(l=>l.who==="agent"&&/come back for/i.test(l.text));
   console.log("reactions:",hits.length,"(cap is 2)");
   hits.forEach(h=>console.log("  ",h.at+"s",h.text));
 });'
```

Expected: between 0 and 2. **More than 2 is a bug** — report it rather than accepting it.

- [ ] **Step 6: Tune, if needed**

If pace is still wrong, change only `speed` **or** only `waitSeconds`, never both, and place another call. Changing both at once loses the ability to say which one mattered.

---

## Self-Review

**Spec coverage.** Pace → Task 1. Schema, cap, trigger → Task 2. `staff_pick` in the payload and its sold-out suppression → Task 3. Prompt rule, replacement of both vague lines, no first-person preference, hash re-bless → Task 4. Operator checkbox, cap surfaced as a sentence → Task 5. Rollout, re-push, real call, countable verification → Task 6. Non-goals (`temperature`, `eleven_v3`, owner-side editing) appear in no task, correctly.

**Placeholders.** None. Every code step carries the code; the two places that say "read the neighbouring test and copy its shape" are pointing at a real existing pattern rather than deferring a decision, and name the file to read.

**Type consistency.** `is_staff_pick` (DB column, `MenuItemRow`) → `staff_pick` (agent payload) → `staffPick` (form input) → `is_staff_pick` (patch). Three names for one fact, each following the convention of its own layer — DB snake_case, tool payload snake_case, TS form camelCase — matching how `sold_out_until` / `soldOutUntil` already crosses the same boundaries in this codebase.

**Known gap, flagged rather than hidden.** Task 2 Step 4 requires Docker for the local Postgres. It is not installed on this machine, so the trigger may have to be verified against the remote project by hand. The task says to record which route was used, because an unverified trigger is exactly the failure the task exists to prevent.
