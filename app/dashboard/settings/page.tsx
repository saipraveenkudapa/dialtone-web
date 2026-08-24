import { Corners } from "@/components/Corners";
import { getCurrentLocation } from "@/lib/data";
import { dialableNumber } from "@/lib/phone";

export const metadata = { title: "Settings · Dialtone" };

/** WHAT THIS RESTAURANT'S PHONE SETUP LOOKS LIKE, AND WHO CAN CHANGE IT.
 *
 *  The mockup draws this screen with toggles. Every control it draws is
 *  either baked into the Vapi assistant (the greeting) or gated on the
 *  operator (recording, the phone numbers), and lib/admin/edit.ts's
 *  SYNCED_COLUMNS is the authority on which edits drag a rebuild. An
 *  owner-side toggle for a baked field would say Saved while the phone
 *  kept saying the old thing -- a lie this screen refuses to tell.
 *
 *  So this page is the honest half of the mockup's Settings: everything
 *  the restaurant's setup IS, read on the signed-in owner's session, and
 *  a plain statement of who changes what. The operator console's
 *  Answering and Business tabs remain the writable half.
 */
export default async function Page() {
  const location = await getCurrentLocation();
  if (!location) {
    return (
      <>
        <div className="page-head">
          <h1>Settings</h1>
        </div>
        <p className="text-muted empty-note">
          No restaurant is connected to this account yet.
        </p>
      </>
    );
  }

  const greeting = location.greeting_text.trim();
  const fallback = dialableNumber(location.fallback_human_number);
  const agentOn = location.is_live && !location.kill_switch_on;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="text-muted sub">
            How {location.name} answers the phone · {location.timezone}
          </div>
        </div>
      </div>

      <div className="split">
        <div className="panel">
          <div className="card blueprint">
            <Corners />
            <div className="card-kicker">What callers hear first</div>
            {greeting ? (
              <>
                <p className="card-body">&ldquo;{greeting}&rdquo;</p>
                <p className="text-muted sub">
                  Changed by your operator — the phone replays it on the next call after they
                  save it.
                </p>
              </>
            ) : (
              <p className="card-body">
                The default greeting: your restaurant&rsquo;s name, a note that the caller is
                speaking with an automated assistant, and how can I help.
              </p>
            )}
          </div>

          <div className="card blueprint">
            <Corners />
            <div className="card-kicker">Recording</div>
            <p className="card-body">
              {location.recording_enabled
                ? `Calls are recorded and kept ${location.recording_retention_days} day${location.recording_retention_days === 1 ? "" : "s"}. The greeting says so when it is on.`
                : "Calls are not recorded."}
            </p>
          </div>

          <div className="card blueprint">
            <Corners />
            <div className="card-kicker">If the agent can&rsquo;t help</div>
            <p className="card-body">
              The caller is sent to a person
              {fallback ? (
                <>
                  {" "}at <span className="num">{fallback}</span>
                </>
              ) : (
                " — no fallback number is on file yet"
              )}
              .
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="card blueprint admin-facts">
            <Corners />
            <div className="card-kicker">Right now</div>
            <dl>
              <div className="fact-row">
                <dt className="text-muted">The agent</dt>
                <dd>{agentOn ? "Answering calls" : "Not answering"}</dd>
              </div>
              <div className="fact-row">
                <dt className="text-muted">This restaurant</dt>
                <dd>{location.is_live ? "Live" : "Not live yet"}</dd>
              </div>
              <div className="fact-row">
                <dt className="text-muted">Kill switch</dt>
                <dd>
                  {location.kill_switch_on
                    ? "On — every call rings a person"
                    : "Off — the agent picks up"}
                </dd>
              </div>
            </dl>
            <p className="text-muted card-meta">
              The kill switch in the sidebar is yours to press, any time. Everything on this
              page is set with your operator.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
