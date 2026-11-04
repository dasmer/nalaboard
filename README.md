# Burntboard 🏓

The Burnt × Allowance ping pong clubhouse: match feed, flat comments with @mentions, one reaction per person per post, player cards, standings, activity history, and personal agent connections. No administrator features.

## Local app

Node 22 or later:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Configure server credentials before starting. Open http://localhost:4173 for the app connected to the selected backend. Use the isolated test project for synthetic users and games.

## Authentication and data

Only exact @useallowance.com and @getburnt.ai addresses can join. Resend sends first-party, single-use six-digit codes, valid for ten minutes with three verification attempts. Browser sessions use HttpOnly cookies; personal agent keys are shown once, expire after 90 days, and can be revoked. Credentials are stored as hashes. The private InsForge bucket player-photos stores validated, resized WebP photos, served through the public app photo endpoint.

Profiles, photos, game results, notes, comments, reactions, score-correction history, and standings can be read without an account. Emails, notification preferences/subscriptions, personal API keys, and account activity remain authenticated. The server projects public fields; database roles and the private storage bucket retain their existing permissions.

Every mutation is authorized server-side. Only participants can correct scores; revisions prevent concurrent edits from overwriting each other. Match, comment, reaction, and subscription writes require Idempotency-Key. A database transaction saves the change, audit event, and email queue together. Public backend roles have no access to the clubhouse tables or mutation functions.

Email notifications cover matches recorded/corrected, new comments, and new agent connections. Comment recipients are the union of participants, prior commenters, and people mentioned on that match. Each recipient gets at most one email per event; the actor is excluded from social notifications. A mention subscribes immediately, subscriptions remain after comment removal, and a later mention never overrides a mute. Users can mute comments on one match or disable social emails globally; login and agent security emails remain enabled. No reaction emails or grouped messages.

The Agents page creates a named personal key and a setup instruction containing the downloadable skill. The same API powers human and agent actions. See skills/burntboard/SKILL.md for commands; /agent.md serves that file. Agents cannot impersonate another player or acquire administrator powers.

Participants can share a game from the feed, game detail, or recording receipt. The preview offers native sharing, Copy link, and Save card. Shared URLs serve a public game receipt with server-rendered Open Graph metadata and a 1200×630 PNG containing names, series result, match scores, date, and branding. Notes, comments, emails, photos, profiles, and activity history are excluded.

Receipt links are unlisted signed capabilities: anyone holding one can view that receipt, and the main board also provides public game browsing. Corrections update the receipt and version its image URL; external platforms may retain their own preview caches. Rotating OTP_SECRET invalidates existing real receipt links. There is no individual link revocation. Demo receipts use separate process-local signatures and reset on restart. No database changes are required.

## Testing without touching production

The linked development project is burntboard-test (or a fresh burntboard-series-test for series validation), separate from any production backend. Integration tests refuse to run unless APP_ENV=test, the linked project name matches, and the backend URL matches the link. Startup also checks the database environment marker against APP_ENV.

Set EMAIL_TEST_RECIPIENTS to an exact authorized inbox. EMAIL_TEST_SINK optionally routes all eligible test identities to that inbox. bob@am.useallowance.com is the controlled test sink used during development; it is not an eligible signup domain. Set EMAIL_DELIVERY_ENABLED=false while running fixtures to leave notification emails queued; login emails still send to the permitted sink. Production refuses test routing settings.

```sh
npm test
# In another terminal, run the isolated real app:
PORT=4176 APP_ORIGIN=http://localhost:4176 npm run dev
npm run test:integration
```

The integration suite covers real InsForge transactions, authorization, OTP reuse, concurrent corrections, idempotency, subscriptions and mention recipient deduplication, muted recipients, one-reaction replacement, agent revocation, CSRF, pagination, aggregate standings, and private photo uploads. It creates synthetic users and matches only in burntboard-test. Real email receipt and browser walkthroughs are separate checks; passing fixtures does not establish production deployment.

## Production releases

The app requires the Node server and uses InsForge hosting; GitHub Pages is retired. The previous static site and JSON roster/results are available in Git history only. They are never imported into the app. Player onboarding is documented in [SETUP.md](SETUP.md).

1. Use a clean checkout of the approved release and run `npm ci` and `npm test`. Validate backend changes against the isolated test project before releasing.
2. Confirm the CLI link points to the existing production project before applying pending migrations with `npx -y @insforge/cli db migrations up --all`. Review migration order and data preservation; do not recreate tables, reset the environment marker, or seed production.
3. Preserve the server-only INSFORGE_URL, INSFORGE_API_KEY, RESEND_API_KEY, OTP_SECRET, APP_ENV=production, HTTPS APP_ORIGIN, ORIGIN_SECRET, and TRUST_PROXY=true configuration. Production must omit EMAIL_TEST_SINK and EMAIL_TEST_RECIPIENTS. Keep secrets out of the frontend and image build; keep the player-photos bucket private.
4. Update the existing compute service with `npx -y @insforge/cli compute deploy . --name burntboard --always-on --env-file .env.production`. HOST=0.0.0.0 and PORT=8080 are set in the image. Always-on keeps the email queue worker running between visits.
5. Deploy `hosting/` with `npx -y @insforge/cli deployments deploy hosting` only when routing changes. Keep ORIGIN_SECRET identical on frontend and compute. The routing sends the client, API, photos, and skill to the same Node process. Vercel replaces the secret header; the server rejects direct requests without it before trusting visitor-IP headers. Preserve the domain configuration and www redirect. See [Vercel's documented proxy configuration](https://vercel.com/docs/routing/rewrites#restricting-your-origin-to-vercel-traffic).
6. Verify HTTPS, app assets, public read responses, direct-origin rejection, and rejection of retired /demo routes. Keep synthetic game writes and email fixture checks in the test project.

Production is linked as burntboard-production (e4bf0edf-79f4-47b0-ba08-a459cd6a7955). The compute service is b79824a0-7ffe-49a8-9806-9a79e7c8c11b. Credentials remain in ignored local configuration and encrypted hosting settings. Future releases update the existing compute service by name; deploy hosting/ only when routing changes. Neither deployment automatically follows GitHub merges.

The queue leases work to avoid simultaneous workers and uses Resend idempotency keys. Uncertain deliveries stop retrying before the provider's 24-hour deduplication window expires; inspect bb_outbox for unsent rows and last_error during operations. Interrupted delivery may require an operator to reconcile a row with Resend before retrying. There is no in-app admin panel.

Each game is a completed best-of-three series: two matches for a sweep, three when the first two are split. Matches are to 11, win by two. The API accepts an ordered matches array, and the database generates series win totals. Leaderboard wins/losses count games, with wins then fewest losses determining rank; equal records share a rank. Numerical points are not ranked. Exact results finish 11–0 through 11–9; deuce and forgotten scores store a result type and winner slot (1 or 2), with no numerical scores. The additive match-result-types migration replaces validation and standings functions without rewriting existing games or audit history. Apply it before deploying the new app; no table rebuild or score conversion is needed.

## Weekly recap

Registered players default into a separate Weekly recap preference. The existing always-on server checks the database schedule once per minute: Friday at 7:30 PM America/Los_Angeles (DST-aware), with up to 24 hours of outage catch-up. The recap covers games dated Sunday through Friday and recorded by Friday's cutoff. Result history reconstructs corrections as of the cutoff. Empty weeks are recorded without emails; repeated/concurrent checks cannot enqueue a second recap.

One stored weekly snapshot drives every recipient's winner-focused email. Leaders are ranked by game wins, then fewest losses; all tied leaders get crowned cards. Each leader's full game table includes losses and opponent avatars. Copy and subjects use fixed templates, never an LLM. It comes from Burntboard <info@burntboard.com> through the existing Resend outbox, with stable delivery idempotency keys. Preference is checked again before delivery so a queued email can be cancelled by opting out.

Manage weekly recap emails opens `/#weekly-emails/TOKEN`; GET only reads the status. The player must tap Unsubscribe on the site. This scoped signed link needs no login and can only opt out of weekly recaps, not authenticate, subscribe, or change another preference. Authenticated players can enable/disable Weekly recap in their account (or POST /api/v1/weekly-preference with an enabled boolean). Rotating OTP_SECRET invalidates old preference links; signed-in account controls still work.

Apply `20261013200000_weekly-recap.sql` to the intended backend before deploying the app. It adds the default-on player preference, a private weekly snapshot table, and privileged scheduling/preference functions; it does not recreate existing tables. The existing production compute service must remain always-on. Validate with `npm test`, `npm run test:integration`, and `npm run test:weekly-integration` only against the isolated test project with EMAIL_DELIVERY_ENABLED=false. Recap delivery tests intercept Resend; they do not send real email.


## Daily matchups

Registered players default into Daily matchups, separate from weekly and social emails. Monday–Friday at 8 AM America/Los_Angeles, the always-on worker freezes the opted-in roster and recorded games from the preceding 28 calendar days. Signup after the cutoff waits until the next workday. The scheduler checks once per minute; delivery continues every 15 seconds. Brief outages catch up until 10 AM Pacific; later sends are cancelled rather than sending stale morning recommendations.

The server builds a random reciprocal lineup with up to two distinct opponents per person. Fresh choices exclude anyone played or recommended on the previous Pacific calendar day, including an unplayed recommendation. Cryptographic shuffling selects among eligible pairs; simple rewiring fills additional slots when possible. There are no skill, historical-frequency or recency weights. This is a bounded pairing heuristic, not a guarantee of uniform distribution over all possible lineups or maximum coverage. Use two fresh opponents when possible, or one when only one can be assigned. A player with no fresh options gets a random mutual rematch labeled Run it back. Pair stranded players together first; a partner can receive a second fallback for an odd pool, but nobody exceeds two total opponents. If everyone else is already full, replace one fresh pairing to make room for the stranded player. When there are no opponents, send just yesterday’s recap if it exists; otherwise skip the email. The winning lineup is stored atomically before any email is queued; concurrent attempts may draw different candidates, but only one is persisted and issued. Friday recommendations do not block Monday unless those players also played on Sunday. No LLM, acceptance workflow, or reminders.

Daily emails use the branded Resend sender and avatar cards linking to player profiles. Roster/history/pairs persist in a private daily snapshot; locked queue finalization and existing outbox idempotency prevent duplicate emails on retries or concurrent servers. Recipient and opponent participation are rechecked before sending; a late opt-out can reduce another person's email to one opponent or cancel it. Emails already delivered cannot be retracted.

Daily matchups in account settings controls both email receipt and participation. `/#daily-emails/TOKEN` opens a read-only preference page; explicit Unsubscribe opts out without login. Purpose-separated signatures cannot affect weekly settings, authenticate, or resubscribe. Signed-in humans and agents can GET/POST `/api/v1/daily-preference` with `{ "enabled": true/false }` for their own account. The preference is excluded from public roster data.

Merge the weekly recap prerequisite (PR #26), then apply `20261014080000_daily-matchups.sql` before deploying this app. Validate with `npm test`, `npm run test:integration`, and `npm run test:daily-integration` in the isolated test backend with delivery disabled. Transport tests intercept Resend; no real emails are sent.


The daily email ends with Yesterday at the table when any games were played on the previous Pacific calendar date and recorded by the 8 AM cutoff. Each compact row shows avatars, names and series totals, with names/results linking to the game. All public results are included, regardless of the players' email preferences; no notes, comments, individual match scores or account fields are included. The result snapshot uses the latest score history at or before the cutoff, then stays fixed across queue retries. Empty days omit the section; previously frozen snapshots are not backfilled or re-sent.

Apply `20261014180000_daily-results.sql` before deploying the daily recap update. It replaces the snapshot function only, preserves its privileged access, and leaves existing runs and delivery safeguards intact.


Apply `20261018090000_random-matchups.sql` before deploying random matchups. It freezes prior-day played/recommended exclusions, upgrades unfinished older snapshots, and validates at most two opponents, allowing repeats only to connect someone with no fresh options. Previously queued lineups remain unchanged; players with an opponent or yesterday’s recap get email. This replaces the earlier weighted rotation algorithm.
