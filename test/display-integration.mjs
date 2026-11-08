import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config, db, query, rpc } from "../server/config.mjs";
import { hash, secret, otpHash } from "../server/auth.mjs";
const linked = JSON.parse(
  readFileSync(new URL("../.insforge/project.json", import.meta.url)),
);
assert.equal(config.environment, "test");
assert.ok(
  ["nalaboard-test", "nalaboard-series-test"].includes(linked.project_name),
);
assert.equal(config.url, linked.oss_host);
const startedAt = new Date().toISOString();
const origin = process.env.TEST_ORIGIN || "http://localhost:4178",
  prefix = "display" + Date.now().toString(36);
let checks = 0;
const check = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label);
  checks++;
};
async function call(
  path,
  method = "GET",
  body,
  cookie = "",
  key = randomUUID(),
) {
  const res = await fetch(origin + "/api/v1" + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookie,
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    value: await res.json(),
    cookies: res.headers.getSetCookie(),
  };
}
async function login(suffix, admin = false) {
  const email = prefix + suffix + "@nala.money";
  await rpc("nb_request_otp", {
    p_email: email,
    p_hash: otpHash(email, "123450"),
    p_ip: prefix + suffix,
  });
  const out = await call("/auth/verify", "POST", { email, code: "123450" });
  check(out.status, 200);
  const cookie = out.cookies[0].split(";")[0],
    who = (await call("/state", "GET", undefined, cookie)).value.user;
  if (admin)
    await query(
      db.database.from("nb_display_admins").insert([{ player_id: who.id }]),
    );
  return { email, cookie, id: who.id };
}
await query(
  db.database
    .from("nb_rate_limits")
    .delete()
    .eq("key", "display:ip:" + hash("127.0.0.1")),
);
const a = await login("admin", true),
  b = await login("other"),
  ids = [a.id, b.id],
  displayIds = [];
async function pair() {
  const out = await call("/display/pair", "POST", {});
  check(out.status, 200);
  check(
    out.value.qr.startsWith("data:image/png;base64,"),
    true,
    "Real QR image",
  );
  return { ...out.value, cookie: out.cookies[0].split(";")[0] };
}
const match = {
  player1: a.id,
  opponent: b.id,
  games: [{ score1: 11, score2: 7 }],
};
try {
  check(
    (await call("/display/identity", "GET", undefined, a.cookie)).value.admin,
    true,
  );
  check(
    (await call("/state", "GET", undefined, a.cookie)).value.displayAdmin,
    true,
  );
  check(
    (await call("/display/identity", "GET", undefined, b.cookie)).value.admin,
    false,
  );
  const d = await pair();
  check(
    (await call("/display/state", "GET", undefined, d.cookie)).value.active,
    false,
  );
  check(
    (await call("/display/matches", "POST", match, d.cookie)).status,
    401,
    "Unpaired device cannot write",
  );
  check(
    (await call("/display/approve", "POST", { code: d.code }, b.cookie)).status,
    403,
    "Non-admin cannot pair",
  );
  const approvals = await Promise.all([
    call("/display/approve", "POST", { code: d.code }, a.cookie),
    call("/display/approve", "POST", { code: d.code }, a.cookie),
  ]);
  check(
    approvals.map((r) => r.status).sort(),
    [200, 409],
    "Pairing is one-use under concurrency",
  );
  check(
    (await call("/state", "GET", undefined, a.cookie)).value.user.id,
    a.id,
    "Remote activation keeps personal login",
  );
  const initial = await call("/display/state", "GET", undefined, d.cookie);
  check(initial.value.active, true);
  check(initial.value.events, [], "No old wins replay");
  check(
    initial.value.snapshot.players.some((p) => "email" in p),
    false,
  );
  const unchanged = await call(
    "/display/state?" +
      new URLSearchParams({
        cursor: initial.value.cursor,
        version: initial.value.version,
      }),
    "GET",
    undefined,
    d.cookie,
  );
  check(unchanged.value.snapshot, null, "Unchanged polls omit the snapshot");
  const key = randomUUID(),
    saved = await call("/display/matches", "POST", match, d.cookie, key);
  check(saved.status, 200, "Display records single-game match");
  check(
    (await call("/display/matches", "POST", match, d.cookie, key)).value.id,
    saved.value.id,
    "Retries are idempotent",
  );
  check(
    (
      await call(
        "/display/matches",
        "POST",
        { ...match, games: [{ score1: 11, score2: 8 }] },
        d.cookie,
        key,
      )
    ).status,
    409,
    "Different payload cannot reuse request key",
  );
  const events = await call(
    "/display/state?" +
      new URLSearchParams({
        cursor: initial.value.cursor,
        version: initial.value.version,
      }),
    "GET",
    undefined,
    d.cookie,
  );
  check(
    events.value.events.some((e) => e.id === saved.value.id),
    true,
    "Incoming result reaches every display",
  );
  const receipt = (
    await call("/state?match=" + saved.value.id)
  ).value.matches.find((m) => m.id === saved.value.id);
  check(receipt.history[0].text, "Recorded on the office display");
  check(receipt.history[0].display, true, "History marks display provenance");
  const emails = await query(
    db.database
      .from("nb_outbox")
      .select("recipient")
      .eq("payload->>matchId", saved.value.id)
      .limit(5),
  );
  check(
    emails.some((e) => e.recipient === b.id),
    true,
    "Existing participant notification is queued",
  );
  check(
    (await call("/matches", "POST", match, d.cookie)).status,
    401,
    "Display cookie grants no personal API access",
  );
  check((await call("/me", "PATCH", { bio: "No" }, d.cookie)).status, 401);
  check(
    (await call("/agent-keys", "POST", { label: "No" }, d.cookie)).status,
    401,
  );
  const raw = d.cookie.split("=")[1];
  check(
    (
      await query(
        db.database.rpc("nb_mutate", {
          p_token: hash(raw),
          p_action: "match.corrected",
          p_match: saved.value.id,
          p_body: {},
          p_key: randomUUID(),
          p_fingerprint: "x",
        }),
      )
    ).status,
    403,
    "Database also limits display operations",
  );
  const invalid = { ...match, games: [{ score1: 11, score2: 10 }] };
  check(
    (await call("/display/matches", "POST", invalid, d.cookie)).status,
    400,
  );
  check(
    (
      await call(
        "/display/matches",
        "POST",
        { ...match, opponent: a.id },
        d.cookie,
      )
    ).status,
    400,
  );
  const three = await call(
    "/display/matches",
    "POST",
    {
      ...match,
      games: [
        { score1: 11, score2: 7 },
        { score1: 9, score2: 11 },
        { type: "deuce", winner: 2 },
      ],
    },
    d.cookie,
  );
  check(three.status, 200, "Three-game decider");
  const agentToken = secret();
  await query(
    db.database
      .from("nb_sessions")
      .insert([
        {
          player_id: a.id,
          token_hash: hash(agentToken),
          kind: "agent",
          label: "Display test agent",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        },
      ]),
  );
  const beforeAgent = (await call("/display/state", "GET", undefined, d.cookie))
    .value;
  const agentRes = await fetch(origin + "/api/v1/matches", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + agentToken,
      "Idempotency-Key": randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      opponent: b.id,
      games: [{ type: "unrecorded", winner: 2 }],
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    }),
  });
  check(agentRes.status, 200, "Agent recording stays on the personal API");
  const agentMatch = await agentRes.json();
  const afterAgent = await call(
    "/display/state?" +
      new URLSearchParams({
        cursor: beforeAgent.cursor,
        version: beforeAgent.version,
      }),
    "GET",
    undefined,
    d.cookie,
  );
  check(
    afterAgent.value.events.some((e) => e.id === agentMatch.id),
    true,
    "Agent result reaches display celebrations",
  );
  const beforeCorrection = (
    await call("/display/state", "GET", undefined, d.cookie)
  ).value;
  check(
    (
      await call(
        "/matches/" + saved.value.id,
        "PATCH",
        { games: [{ type: "unrecorded", winner: 2 }], revision: 1 },
        a.cookie,
      )
    ).status,
    200,
  );
  const corrected = await call(
    "/display/state?" +
      new URLSearchParams({
        cursor: beforeCorrection.cursor,
        version: beforeCorrection.version,
      }),
    "GET",
    undefined,
    d.cookie,
  );
  check(corrected.value.events, [], "Correction never repeats a celebration");
  check(corrected.value.snapshot !== null, true, "Correction updates board");
  const listed = await call("/displays", "GET", undefined, a.cookie);
  check(listed.status, 200);
  displayIds.push(
    ...listed.value.displays.filter((x) => !x.revoked_at).map((x) => x.id),
  );
  const ownId = (
    await query(
      db.database
        .from("nb_displays")
        .select("id")
        .eq("token_hash", hash(raw))
        .limit(1),
    )
  )[0].id;
  check(
    (await call("/displays/" + ownId, "DELETE", undefined, b.cookie)).status,
    403,
  );
  check(
    (await call("/displays/" + ownId, "DELETE", undefined, a.cookie)).status,
    200,
  );
  check(
    (await call("/display/matches", "POST", match, d.cookie)).status,
    401,
    "Revocation blocks writes immediately",
  );
  const local = await pair(),
    sameCookie = local.cookie + "; " + a.cookie;
  check(
    (
      await call(
        "/display/identity?code=" + encodeURIComponent(local.code),
        "GET",
        undefined,
        sameCookie,
      )
    ).value.local,
    true,
    "Same-browser manual activation is detected",
  );
  check(
    (await call("/display/approve", "POST", { code: local.code }, sameCookie))
      .value.local,
    true,
  );
  check(
    (await call("/state", "GET", undefined, a.cookie)).value.user,
    null,
    "Same-browser activation revokes only that personal session",
  );
  const freshAdmin = await login("admin2", true);
  ids.push(freshAdmin.id);
  const temp = await pair();
  await rpc("nb_request_otp", {
    p_email: freshAdmin.email,
    p_hash: otpHash(freshAdmin.email, "123450"),
    p_ip: prefix + "temp",
  }).catch(async () => {
    await query(
      db.database
        .from("nb_otp")
        .update({
          code_hash: otpHash(freshAdmin.email, "123450"),
          consumed_at: null,
          attempts: 0,
          expires_at: new Date(Date.now() + 60000).toISOString(),
        })
        .eq("email", freshAdmin.email),
    );
  });
  const sessionCount = (
    await query(
      db.database
        .from("nb_sessions")
        .select("id")
        .eq("player_id", freshAdmin.id)
        .limit(100),
    )
  ).length;
  check(
    (
      await call(
        "/display/local/verify",
        "POST",
        { email: freshAdmin.email, code: "123450", displayCode: temp.code },
        temp.cookie,
      )
    ).status,
    200,
  );
  check(
    (
      await query(
        db.database
          .from("nb_sessions")
          .select("id")
          .eq("player_id", freshAdmin.id)
          .limit(100),
      )
    ).length,
    sessionCount,
    "Local verification creates no personal session",
  );
  check(
    (await call("/state", "GET", undefined, freshAdmin.cookie)).value.user.id,
    freshAdmin.id,
    "Local verification preserves admin’s other devices",
  );
  const expiry = await pair();
  await query(
    db.database
      .from("nb_displays")
      .update({ pairing_expires_at: "2000-01-01" })
      .eq("token_hash", hash(expiry.cookie.split("=")[1])),
  );
  check(
    (
      await call(
        "/display/approve",
        "POST",
        { code: expiry.code },
        freshAdmin.cookie,
      )
    ).status,
    409,
    "Expired pairing cannot activate",
  );
  const boundary = await call("/display/pair", "POST", {});
  const cross = await fetch(origin + "/api/v1/display/matches", {
    method: "POST",
    headers: {
      Origin: "https://evil.test",
      Cookie: temp.cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(match),
  });
  check(cross.status, 403, "Cross-origin display writes rejected");
  // Browser/admin credentials are never exposed in display projections.
  check(JSON.stringify(initial.value).includes("token_hash"), false);
  check(JSON.stringify(listed.value).includes("code_hash"), false);
  console.log(
    `Passed ${checks} display API/database checks on ${linked.project_name}. No production changes or email sends.`,
  );
} finally {
  // Keep the base integration suite’s historical fixtures; remove only this run.
  const results = await query(
    db.database.from("nb_matches").select("id").in("player1", ids).limit(100),
  );
  const matches = results.map((m) => m.id);
  if (matches.length) {
    for (const table of [
      "nb_comments",
      "nb_reactions",
      "nb_subscriptions",
      "nb_activity",
    ])
      await query(db.database.from(table).delete().in("match_id", matches));
    await query(db.database.from("nb_matches").delete().in("id", matches));
  }
  await query(
    db.database
      .from("nb_displays")
      .delete()
      .is("activated_at", null)
      .gte("created_at", startedAt),
  );
  await query(db.database.from("nb_outbox").delete().in("recipient", ids));
  await query(db.database.from("nb_activity").delete().in("actor", ids));
  await query(db.database.from("nb_requests").delete().in("player_id", ids));
  await query(db.database.from("nb_displays").delete().in("activated_by", ids));
  await query(
    db.database.from("nb_display_admins").delete().in("player_id", ids),
  );
  await query(db.database.from("nb_sessions").delete().in("player_id", ids));
  await query(db.database.from("nb_players").delete().in("id", ids));
}
