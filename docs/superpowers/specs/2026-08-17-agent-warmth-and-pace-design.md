# The agent sounds calmer, and means it when she compliments a dish

Date: 2026-08-17
Status: approved, not yet implemented

## The problem

Two complaints from a real call, in the product owner's words: the agent's
pace is "too fast — I just wanted it calm and a little slow, not too slow,
like a regular pace", and the conversation is transactional where it could
be engaging — "if a customer orders a cheeseburger I want the agent to say
a good choice".

The second one is the interesting half, because **the prompt already asks
for it, twice**. `lib/agent/prompt.ts:11` says *"react to what they say
instead of just moving to the next question... A quick 'nice' or 'good
choice' goes a long way"*, and line 64 repeats it for order-taking. She is
being told and is not doing it. So this is not a missing instruction. It is
an instruction losing to a competing one.

The likeliest culprit sits four lines below it: *"Keep every reply short.
One or two sentences."* That rule is concrete and countable. "A quick nice
goes a long way" is neither. When a model has to choose, the specific rule
wins. The fix is to make the warm behaviour as concrete as the rule beating
it — this dish, this phrasing, this many times — rather than to ask louder.

A second suspect is `temperature: 0.3`, deliberately low so she does not
invent menu items. It is **not** being changed here; see Non-goals.

## What we are building

### 1. Pace

Two settings, both currently default or unset, changed as house defaults in
`lib/vapi/provision.ts`:

| Setting | Current | New |
|---|---|---|
| `voice.speed` | unset (ElevenLabs default 1.0) | `0.92` |
| `START_SPEAKING_PLAN.waitSeconds` (provision.ts:418) | `0.6` | `0.8` |

House-wide, not per-restaurant. Every restaurant should sound composed, and
one dial to tune beats one per location. Both values are baked into the
assistant at build time, so changing them requires re-pushing every
assistant — see Rollout.

These are starting values chosen to be conservative, to be tuned by ear.
`speed` below ~0.85 sounds sedated; `waitSeconds` above ~1.2 reads as dead
air, and dead air is what makes callers say "hello? are you there?".

### 2. Staff picks

A restaurant nominates up to **three** dishes it stands behind. The agent
reacts warmly only to those.

- **Schema.** `menu_items.is_staff_pick boolean not null default false`.
- **The cap is enforced in the database**, by a trigger that refuses a write
  taking a location above three. A `CHECK` constraint cannot count sibling
  rows, and a limit that exists only in a form is not a limit — the same
  posture the rest of this schema takes.
- **Who sets them.** The operator, in the Menu tab of the console. The
  checkbox disables at three and says why. Owner-side editing is a follow-up.
- **The agent's view.** `shapeMenu` (`lib/agent/menu.ts`) adds
  `staff_pick: true` to those items in the `get_menu` payload. Absent
  otherwise — not `false` — so the payload does not grow for the 43 items
  that are not picks.
- **A sold-out pick is not a pick.** `shapeMenu` suppresses `staff_pick`
  whenever `sold_out` is true for that item. Praising a dish and then
  refusing it in the same breath is worse than saying nothing, and the flag
  is set by an owner weeks earlier while sold-out is set by a manager
  mid-service — the fresher fact wins. This is suppressed in the payload
  rather than left to the prompt, so the agent is never holding a
  contradiction it has to reason its way out of mid-call.

### 3. The prompt

The two existing generic lines (prompt.ts:11 and :64) are **replaced**, not
supplemented. The new rule is specific and bounded:

- React only to an item `get_menu` marked as a staff pick.
- At most **twice per call**.
- In the restaurant's voice, not her own: **"that's the one people come
  back for"**.

She must never claim a preference of her own. "Oh, that's my favourite" is a
claim she cannot honestly make, and the prompt already commits her to
answering truthfully when a caller asks whether she is an AI. A caller who
hears her name a favourite dish and then hears "I'm the automated assistant"
has caught her in something.

The allergy rule and its sentence "There are no exceptions to this." are
untouched. No reaction fires once an allergy has come up — that call is
already transferring, and the existing rule against offering add-ons in that
state extends to this.

## Non-goals

- **`temperature` stays at 0.3.** It is the second suspect for the flatness
  and raising it would probably help, but it is the same dial that keeps her
  from inventing menu items and mishearing orders. Instruction first. If the
  next call still sounds flat, temperature becomes its own change, so we know
  which thing did what.
- **No `eleven_v3` / audible laughter.** Inline audio tags like `[laughs]`
  are an `eleven_v3` feature; the live voice is `eleven_flash_v2_5`, where a
  tag would most likely be read aloud to the caller as the word "laughs".
  Staged as phase B — see Open questions.
- **No owner-side staff-pick editing.** Every restaurant is onboarded by
  hand today and the owner dashboard has two stub screens already; moving
  the checkbox there later is small.

## Testing

- `lib/agent/prompt.test.ts` hash-pins the prompt. The pin is re-blessed
  deliberately, with the old hash and the changed lines recorded, so the
  wording cannot drift unnoticed.
- New assertions that the reaction rule names the staff-pick condition, the
  two-per-call cap, and the approved phrasing; and that it does **not**
  contain a first-person preference claim.
- `lib/agent/menu.test.ts`: `staff_pick` present on picks, absent otherwise,
  and absent on a pick that is sold out — including a pick sold out "until
  reopen" and one sold out "until close".
- Trigger tests in `supabase/tests/rls_test.sql`: a fourth pick is refused;
  three are allowed; unmarking frees a slot; a pick on location A does not
  count against location B.
- `lib/vapi/provision.test.ts`: the payload carries `speed: 0.92` and
  `waitSeconds: 0.8`.

**None of that proves it sounds better.** The only real verification is a
call. Afterwards the transcript can be counted — did she react, to what, how
often — which is a countable question, unlike pace.

## Rollout

1. Migration and trigger.
2. Console checkbox; mark up to three on a real restaurant.
3. Prompt and voice changes; re-push the assistant with
   `scripts/provision-vapi.mjs`, which carries the existing agent secret
   forward and therefore does not rotate it.
4. A real call. Tune `speed` and `waitSeconds` by ear from there.

Every existing assistant must be re-pushed for the pace change to take
effect — there are two today, so this is manual and fine. It will not stay
fine, and a re-push-all is worth building before there are twenty.

## Open questions

- **Phase B has nowhere safe to run.** Nonna Rosa is the only live number,
  so trialling a slower, more expressive voice there means real customers
  hear the experiment. Marty's has an assistant but no number. Phase B
  realistically needs a second number first — one click now that the
  area-code fix is in, but a real cost to decide on before committing.
