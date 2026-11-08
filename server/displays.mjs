import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { config, db, readQuery, rpc } from "./config.mjs";
import {
  cookie,
  emailAddress,
  error,
  hash,
  identity,
  otpHash,
  requestCode,
  secret,
} from "./auth.mjs";
import { matchScore } from "../series.mjs";
const credential = (req) =>
  /(?:^|;\s*)nb_display=([^;]+)/.exec(req.headers.cookie || "")?.[1];
const digest = (req) => (credential(req) ? hash(credential(req)) : null);
export function displayCookie(token, maxAge = 90 * 86400) {
  return `nb_display=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.origin.startsWith("https:") ? "; Secure" : ""}`;
}
function setCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [...(existing ? [existing].flat() : []), value]);
}
const codeHash = (code) => {
  const normalized = String(code || "")
    .toUpperCase()
    .replace(/[ -]/g, "");
  if (!/^[A-F0-9]{10}$/.test(normalized))
    throw error("Enter the display code.");
  return hash(normalized);
};
export async function isDisplayAdmin(who) {
  if (!who || who.session.kind !== "web") return false;
  return (
    (
      await readQuery(() =>
        db.database
          .from("nb_display_admins")
          .select("player_id")
          .eq("player_id", who.user.id)
          .limit(1),
      )
    ).length > 0
  );
}
export async function displayAPI(req, res, path, body, url, ip) {
  const device = digest(req);
  if (path === "/display/pair" && req.method === "POST") {
    const token = secret(),
      code = randomBytes(5).toString("hex").toUpperCase();
    const out = await rpc("nb_display_begin", {
      p_token: hash(token),
      p_code: hash(code),
      p_ip: hash(ip),
    });
    setCookie(res, displayCookie(token));
    return {
      ...out,
      code: code.slice(0, 5) + "-" + code.slice(5),
      qr: await QRCode.toDataURL(config.origin + "/activate?code=" + code),
    };
  }
  if (path === "/display/state" && req.method === "GET") {
    if (!device) throw error("Activate this display.", 401);
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !/^\d{1,18}$/.test(cursor))
      throw error("Invalid display cursor.");
    const out = await rpc("nb_display_state", {
      p_token: device,
      p_version: url.searchParams.get("version"),
      p_cursor: cursor,
    });
    // Sliding cookie is refreshed at most once per hour by the client.
    if (url.searchParams.get("renew") === "1")
      setCookie(res, displayCookie(credential(req)));
    return out;
  }
  if (path === "/display/matches" && req.method === "POST") {
    if (!device) throw error("Activate this display.", 401);
    if (
      !/^[0-9a-f-]{36}$/i.test(body.player1 || "") ||
      !/^[0-9a-f-]{36}$/i.test(body.opponent || "")
    )
      throw error("Choose both players.");
    const games = matchScore(body.games);
    return rpc("nb_mutate", {
      p_token: device,
      p_action: "match.recorded",
      p_match: null,
      p_body: {
        ...games,
        player1: body.player1,
        opponent: body.opponent,
        date: new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/London",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
      },
      p_key: req.headers["idempotency-key"] || null,
      p_fingerprint: hash(
        JSON.stringify({
          player1: body.player1,
          opponent: body.opponent,
          games: games.games,
        }),
      ),
    });
  }
  if (path === "/display/qr" && req.method === "GET") {
    res.setHeader("Content-Type", "image/png");
    res.end(await QRCode.toBuffer(config.origin + "/#record-match"));
    return null;
  }
  const result = /^\/display\/match\/([0-9a-f-]{36})$/i.exec(path);
  if (result && req.method === "GET") {
    if (!device) throw error("Activate this display.", 401);
    const devices = await readQuery(() =>
      db.database
        .from("nb_displays")
        .select("activated_at,revoked_at,last_seen_at")
        .eq("token_hash", device)
        .limit(1),
    );
    const display = devices[0];
    if (
      !display?.activated_at ||
      display.revoked_at ||
      Date.parse(display.last_seen_at) <= Date.now() - 90 * 86400000
    )
      throw error("Activate this display.", 401);
    const rows = await readQuery(() =>
      db.database
        .from("nb_matches")
        .select("id,player1,player2,score1,score2,games,date,revision")
        .eq("id", result[1])
        .limit(1),
    );
    if (!rows.length) throw error("Match not found.", 404);
    return rows[0];
  }
  const who = await identity(req);
  if (path === "/display/identity" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const own =
      device && code
        ? await readQuery(() =>
            db.database
              .from("nb_displays")
              .select("id")
              .eq("token_hash", device)
              .eq("code_hash", codeHash(code))
              .limit(1),
          )
        : [];
    return {
      user: who?.session.kind === "web" ? { name: who.user.name } : null,
      admin: await isDisplayAdmin(who),
      local: own.length > 0,
    };
  }
  if (path === "/display/local/request" && req.method === "POST") {
    if (!device) throw error("Open activation on the display.", 401);
    const email = emailAddress(body.email);
    const people = await readQuery(() =>
      db.database.from("nb_players").select("id").eq("email", email).limit(1),
    );
    const admins = people.length
      ? await readQuery(() =>
          db.database
            .from("nb_display_admins")
            .select("player_id")
            .eq("player_id", people[0].id)
            .limit(1),
        )
      : [];
    if (!admins.length)
      throw error("Only display admins can activate this screen.", 403);
    return requestCode({ email }, ip);
  }
  if (path === "/display/local/verify" && req.method === "POST") {
    if (!device) throw error("Open activation on the display.", 401);
    if (!/^\d{6}$/.test(String(body.code)))
      throw error("Enter the email code.", 401);
    const email = emailAddress(body.email);
    const out = await rpc("nb_display_verify", {
      p_email: email,
      p_hash: otpHash(email, body.code),
      p_code: codeHash(body.displayCode),
      p_device: device,
      p_personal: who?.tokenHash || null,
    });
    if (out.local) setCookie(res, cookie("", 0));
    return out;
  }
  if (path === "/display/approve" && req.method === "POST") {
    if (!who || who.session.kind !== "web")
      throw error("Sign in to activate a display.", 401);
    const out = await rpc("nb_display_approve", {
      p_token: who.tokenHash,
      p_code: codeHash(body.code),
      p_device: device,
    });
    if (out.local) setCookie(res, cookie("", 0));
    return out;
  }
  if (path === "/displays" && req.method === "GET") {
    if (!(await isDisplayAdmin(who)))
      throw error("Only display admins can manage displays.", 403);
    return {
      displays: await readQuery(() =>
        db.database
          .from("nb_displays")
          .select("id,activated_at,last_seen_at,revoked_at")
          .not("activated_at", "is", null)
          .order("activated_at", { ascending: false })
          .limit(100),
      ),
    };
  }
  const revoke = /^\/displays\/([0-9a-f-]{36})$/.exec(path);
  if (revoke && req.method === "DELETE") {
    if (!who || who.session.kind !== "web")
      throw error("Sign in to continue.", 401);
    return rpc("nb_display_revoke", {
      p_token: who.tokenHash,
      p_id: revoke[1],
    });
  }
  throw error("Not found.", 404);
}
