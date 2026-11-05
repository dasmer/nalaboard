# Nalaboard 🏓

Good colleagues. Great rivals. The Nala team’s table tennis clubhouse in Canary Wharf, London, adapted from [Burntboard](https://github.com/dasmer/burntboard).

Public game feeds, player cards, standings, rivalries, comments with @mentions, reactions, correction history, shareable game receipts, and personal agent connections. Sign in with an exact **@nala.money**, **@rafiki.com**, or **@useallowance.com** address. Other domains, including @nala.com, cannot join.

Games are best of three matches, played to 11. Record exact scores from 11–0 through 11–9, choose a deuce winner, or record who won when the score is forgotten. Two match wins finish the game. Standings count game wins, then fewest losses; equal records share a rank. Participants can correct results with revision checks and a preserved paper trail. Players join themselves; there is no administrator role or imported roster.

## Local development

Node 22 or later:

```sh
npm ci
npx -y @insforge/cli link --project-id 6fe9e22b-0892-486d-871f-5ef4816958e9 -y
cp .env.example .env.local
# Set a random OTP_SECRET and a test email provider key/sink when testing delivery.
PORT=4176 APP_ORIGIN=http://localhost:4176 npm run dev
```

The ignored CLI link supplies the real backend URL and server-only admin key. Never put admin credentials in browser code. Set the test database’s `nb_environment` marker to `test` before starting. Keep `EMAIL_DELIVERY_ENABLED=false` for fixture runs. Login delivery has its own exact test-recipient allowlist; do not send fixture email to employees.

## Architecture and access

A small Node HTTP server serves vanilla JavaScript/CSS and accesses InsForge with `createAdminClient`. The app owns email OTP login and opaque sessions; InsForge built-in user authentication is not used. Resend delivers single-use six-digit codes, valid for ten minutes with three verification attempts and email/IP rate limits. Browser sessions use HttpOnly cookies and expire in 30 days. Named agent keys expire in 90 days, are shown once, and can be revoked. Tokens and OTPs are stored as hashes.

Database business tables and functions are unavailable to anonymous and authenticated backend roles. Every mutation is authorized by the app and database, with idempotency and transactions covering changes, audit history, and notification queueing. Photos are validated, resized WebP files in the private `player-photos` bucket and served through the app.

The board is intentionally public: profiles, photos, games, notes, comments, reactions, and game correction history can be read without login. Emails, preferences, subscriptions, agent keys, and account activity require login. Only participants can create a signed game receipt link. Anyone holding that link can see names, scores, and date; receipt HTML/PNG excludes notes, comments, emails, photos, and account history. Signed links are unlisted, not confidential, and have no individual revocation. Rotating `OTP_SECRET` invalidates receipt and email-preference links.

## London emails

All calendar boundaries use **Europe/London**, including British Summer Time.

- Match, comment, mention, and agent-security emails retain Burntboard’s behaviour, with per-game mutes and a separate social email preference.
- Daily matchups arrive **Monday–Friday at 8 AM**, with up to two reciprocal random opponents, yesterday’s results, and fresh-opponent/rematch fallbacks. Delivery expires at 10 AM. Participation and delivery share one preference.
- Weekly recaps arrive **Friday at 5 PM**, covering Monday through Friday’s cutoff and recognising the week’s winner(s). This Monday start matches the weekly standings. Later Friday games remain on the board but fall outside that week’s email snapshot.

Daily and weekly preferences default on for new players and can be changed independently. Signed preference links allow an explicit opt-out without login; GET never changes preferences. The always-on server checks schedules every minute and drains the leased email queue every 15 seconds. Frozen snapshots, transactions, and provider idempotency prevent duplicate sends. Uncertain retries stop before Resend’s 24-hour deduplication window. Operators reconcile stuck outbox rows; there is no admin UI.

## Validation

```sh
npm test
# Start the isolated test server first, with delivery disabled:
npm run test:integration
npm run test:weekly-integration
npm run test:daily-integration
```

Integration suites refuse non-test project links and exercise real InsForge transactions, domain restrictions, OTP reuse, authorisation, concurrent corrections, idempotency, pagination, private storage, and BST/GMT schedule boundaries. They create synthetic data only in `nalaboard-test`; they do not verify production email receipt. Use `npm run preview:emails` for email HTML previews.

GitHub’s validation workflow is retained at `.github/validate.yml.example`. To activate it, a repository owner with GitHub `workflow` scope can move it to `.github/workflows/validate.yml`. The credential available during initial creation lacked that scope, so local checks are authoritative for the first PR.

## Independent environments and release

Nalaboard owns separate EU projects:

| Environment | Project ID | Backend |
| --- | --- | --- |
| Production | `dc9303b5-c5fd-46fe-b6b0-19c0c0065d1e` | `https://hsgng6dw.eu-central.insforge.app` |
| Test | `6fe9e22b-0892-486d-871f-5ef4816958e9` | `https://b9d6fq5r.eu-central.insforge.app` |

Live at **https://nalaboard.com**, with `www` redirected to the apex. These project IDs/URLs are public identifiers, not credentials. Production schema, private storage, verified Resend sending, domain routing, and HTTPS are configured. Public reads, rejected login domains, rejected unauthenticated writes, protected compute origin, and a real owner sign-in email were smoke tested. The nominated Nala pilot still needs to complete their own onboarding. Keep credentials in ignored local configuration and hosting secrets; never copy Burntboard’s keys, backend links, routing, or user data.

For future approved releases:

1. Link a release checkout to **nalaboard-production** and verify the project ID. Apply migrations with `npx -y @insforge/cli db migrations up --all`. Preserve the `nb_environment` marker as `production`; do not import test fixtures. Ensure `player-photos` is private.
2. Verify `nalaboard.com` with Resend and configure `Nalaboard <info@nalaboard.com>`. Use a dedicated sending key. Set production `INSFORGE_URL`, `INSFORGE_API_KEY`, `RESEND_API_KEY`, fresh strong `OTP_SECRET` and `ORIGIN_SECRET`, `APP_ENV=production`, `APP_ORIGIN=https://nalaboard.com`, and `TRUST_PROXY=true`. Omit all test routing settings.
3. Update the existing always-on InsForge compute service named `nalaboard`, using `npx -y @insforge/cli compute deploy . --name nalaboard --region lhr --always-on --env-file .env.production`. No source deployment runs automatically after a merge.
4. Deploy `hosting/` only when routing changes. The tracked `hosting/vercel.json` points to the existing Nalaboard compute origin. Keep the same `ORIGIN_SECRET` in frontend hosting and compute; the proxy supplies it before Node trusts forwarded visitor IPs. Direct-origin requests must remain rejected.
5. Preserve the existing Namecheap DNS and email forwarding. Domain attachment, HTTPS, website records, and Resend DKIM/sending records are already configured. If changing providers, use only returned records and preserve unrelated entries. Verify HTTPS, www redirect, app assets, public reads, direct-origin rejection, and disallowed login domains.
6. Ask the nominated pilot, Benjamin, to complete a real email-code login and onboarding. Fixture tests do not establish email receipt or employee acceptance. Do not manufacture player identities or game results in production.

For a future Nala handover, transfer the GitHub repository and InsForge project, arrange ownership of Resend and Namecheap DNS, rotate operational secrets, and give the team the release checklist above. Transfer real accounts; never hand over plaintext keys in repository documentation.

## Live deployment record

- Application release: PR #1, commit `3858a103734322da71ec5f95d343021614291362`.
- Compute: `e145bac3-a9f1-40ea-ab94-dbd7839837cb`, service `nalaboard`, London (`lhr`), always on (`scaleToZero=false`).
- Protected origin: `https://nalaboard-dc9303b5-c5fd-46fe-b6b0-19c0c0065d1e.fly.dev`.
- Resend: `Nalaboard <info@nalaboard.com>`, Ireland region, dedicated sending key restricted to `nalaboard.com`. The key remains server-only.
- DNS: apex A `216.150.16.1`; www CNAME `9764b2d95437e210.vercel-dns-016.com`; `rsend` CNAME `rsend-euw1.forge.rmta.net`; `send` CNAME `send.forge.rmta.net`; provider-generated DKIM TXT at `resend._domainkey`. The existing apex email forwarding MX/SPF were preserved.
- Production launched empty. The email smoke check requested a code for the owner; it did not create a player or invent results. No message was sent to the Nala pilot.
