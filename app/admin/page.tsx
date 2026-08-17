import Link from "next/link";
import { Corners } from "@/components/Corners";
import { getPortfolio } from "@/lib/admin/data";
import { money, relative } from "@/lib/format";

/* The six figures a restaurant carries, named once.
 *
 *  On a phone this table stacks (see .stack-table in app/app.css) and
 *  every figure cell grows a visible label, because its column heading
 *  is no longer above it. That label and the <th> that names the column
 *  on a desktop are the same six strings, and the type below is what
 *  stops them drifting: <Figure label="Answerd"> is a compile error,
 *  not a rendering nobody looks at on a 375px screen. */
const FIGURE_COLUMNS = ["Answered", "Missed", "Orders", "Revenue", "Spend", "Last call"] as const;

/** One figure, with the name of its column attached to it. */
function Figure({
  label,
  warn = false,
  children,
}: {
  label: (typeof FIGURE_COLUMNS)[number];
  warn?: boolean;
  children: string;
}) {
  return (
    <td role="cell" className={warn ? "num num-warn" : "num"}>
      {/* Hidden at desktop, where the <th> above says this. */}
      <span className="cell-label">{label}</span>
      <span>{children}</span>
    </td>
  );
}

const HEALTH_LABEL: Record<string, { text: string; tag: string }> = {
  live: { text: "Answering", tag: "tag tag-accent" },
  "kill-switch": { text: "Kill switch", tag: "tag tag-out" },
  "not-live": { text: "Not live", tag: "tag tag-neutral" },
  "no-forwarding": { text: "Forwarding unproven", tag: "tag tag-outline" },
};

export default async function OperatorPage() {
  const rows = await getPortfolio();

  const totals = rows.reduce(
    (acc, r) => ({
      answered: acc.answered + r.answered,
      missed: acc.missed + r.missed,
      orders: acc.orders + r.orders,
      revenueCents: acc.revenueCents + r.revenueCents,
      spendCents: acc.spendCents + r.spendCents,
      live: acc.live + (r.health === "live" ? 1 : 0),
    }),
    { answered: 0, missed: 0, orders: 0, revenueCents: 0, spendCents: 0, live: 0 },
  );

  const cards = [
    { label: "Restaurants", value: String(rows.length), note: `${totals.live} answering right now` },
    { label: "Calls answered", value: String(totals.answered), note: "today, each in its own timezone" },
    {
      label: "Missed",
      value: String(totals.missed),
      note: totals.missed ? "reached us and nobody picked up" : "nothing slipped through",
    },
    { label: "Orders taken", value: String(totals.orders), note: `${money(totals.revenueCents)} booked` },
    { label: "Call spend", value: money(totals.spendCents), note: "what today cost us" },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Every restaurant</h1>
          <div className="text-muted sub">
            Operator console. Numbers are today in each restaurant&rsquo;s own
            timezone.
          </div>
        </div>
        <div className="actions">
          <Link href="/admin/new" className="btn btn-primary">
            Create a new restaurant
          </Link>
        </div>
      </div>

      <div className="stat-grid">
        {cards.map((c) => (
          <div key={c.label} className="card blueprint stat-card">
            <Corners />
            <div className="card-kicker">{c.label}</div>
            <div className="stat-value">{c.value}</div>
            <div className="text-muted stat-note">{c.note}</div>
          </div>
        ))}
      </div>

      {/* ONE BLOCK SHAPE ACROSS THE CONSOLE.

          This was <section class="panel"><h4>, which is what every
          titled block on /admin/<id> was too -- consistent, and
          consistently unlike the rest of the product. That page's nine
          panels are .card.blueprint.setup-card with an <h2> now, so
          leaving this one behind would have made the portfolio the odd
          screen in a three-click walk: portfolio -> restaurant -> call,
          two block vocabularies and two heading levels.

          .panel stays in the stylesheet and stays correct: it is the
          column wrapper inside a .split, which is what the owner's
          screens and the call detail page use it for. What changes here
          is a titled block, and a titled block in this console is a
          card. */}
      <section className="card blueprint setup-card">
        <Corners />
        <h2>Accounts</h2>
        {rows.length === 0 ? (
          <p className="text-muted empty-note">
            No restaurants yet. Nobody signs themselves up — use{" "}
            <Link href="/admin/new">Create a new restaurant</Link> to make the first one.
          </p>
        ) : (
          /* EIGHT COLUMNS THAT DO NOT FIT A PHONE, AND A SCROLLBAR IS
             NOT AN ANSWER.

             Measured at 375px: this table is 572px wide inside a 300.2px
             box, so 272px of it -- 47.6% -- was off the right edge, and
             the only thing saying so was .table-scroll's overflow-x.
             That hid, in order, Missed, Orders, Revenue, Spend and Last
             call: the first thing lost was the count of callers nobody
             picked up for, which is the single number this page exists
             to surface, and the last was when the restaurant last rang.
             An operator on a phone saw a name, a status chip and part of
             one figure. A sideways scrollbar is an overlay on iOS --
             invisible until something is already moving -- so there was
             not even a hint that five columns existed.

             So below 700px the table STACKS: one restaurant per block,
             the name and its status on the first line, the six figures
             two-up under it, each wearing the name of its own column
             (<Figure> above). Nothing is hidden, nothing scrolls
             sideways, and the block is 375px-safe by construction --
             see .stack-table in app/app.css for the layout and the
             measurements it was sized from.

             THE ARIA ROLES ARE LOAD-BEARING AND NOT DECORATION. That
             stacking is `display: block` on <table>, <tbody>, <tr> and
             <td>, and changing the display of a table element strips its
             implicit role in every current browser -- the whole thing
             flattens to anonymous boxes and a screen reader loses where
             one restaurant ends and the next begins. Naming the roles
             explicitly is what survives the display change; they are
             redundant at desktop, which is the point, because CSS cannot
             add them at the width where they start mattering.

             The column headings themselves are `display: none` at that
             width rather than clipped-but-present, deliberately: an
             ARIA table only announces a column header while navigating
             BY CELL, and nobody triages a portfolio that way on a phone.
             Read linearly -- which is how it will be read -- a clipped
             <thead> would give "0, 0, 0, $0.00, $0.00, 1 d ago" and
             nothing else. The visible label is real text inside the
             cell, so the sighted reader and the screen-reader user get
             the identical sentence. Exactly one of the two labelling
             mechanisms is live at any width. */
          <div className="table-scroll">
            <table className="table stack-table" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader">Restaurant</th>
                  <th role="columnheader">Status</th>
                  {FIGURE_COLUMNS.map((label) => (
                    <th key={label} role="columnheader">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {rows.map((r) => {
                  const health = HEALTH_LABEL[r.health];
                  return (
                    <tr key={r.location.id} role="row">
                      <td role="cell">
                        {/* The name is the link. Not a JS row click: that
                            would make this page a client component, kill
                            text selection, and break cmd-click / middle
                            click / "open in new tab", while announcing a
                            <tr> to a screen reader as if it were a button. */}
                        <div>
                          <Link
                            href={`/admin/${r.location.id}`}
                            className="row-title-link"
                          >
                            {r.location.name}
                          </Link>
                        </div>
                        <div className="caller-city">
                          {r.location.org_name} · {r.location.timezone}
                        </div>
                      </td>
                      <td role="cell">
                        <span className={health.tag}>{health.text}</span>
                      </td>
                      <Figure label="Answered">{String(r.answered)}</Figure>
                      <Figure label="Missed" warn={r.missed > 0}>
                        {String(r.missed)}
                      </Figure>
                      <Figure label="Orders">{String(r.orders)}</Figure>
                      <Figure label="Revenue">{money(r.revenueCents)}</Figure>
                      <Figure label="Spend">{money(r.spendCents)}</Figure>
                      <Figure label="Last call">
                        {r.lastCallAt ? relative(r.lastCallAt) : "never"}
                      </Figure>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
