import { api, esc, avatar, rankRows } from "./display-client.mjs";
import { matchScore, gameWinner, gameLabel } from "./series.mjs";
const root = document.querySelector("#screen"),
  connection = document.querySelector("#connection"),
  notice = document.querySelector("#notice");
let scene = "loading",
  snapshot,
  version = null,
  cursor = null,
  pair,
  queue = [],
  seen = new Set(),
  draft,
  celebration,
  timer,
  celebrationTicker,
  idle,
  warning,
  polling = false,
  lastSuccess = 0,
  lastRenew = 0,
  error = "",
  wake;
const person = (id) =>
  snapshot?.players.find((p) => p.id === id) || {
    id,
    name: "Player",
    avatar: "🏓",
  };
const name = (id) => person(id).name;
const button = (label, action, cls = "", extra = "") =>
  `<button class="action ${cls}" data-action="${action}" ${extra}>${label}</button>`;
const errorNode = () => `<p class="error" role="alert">${esc(error)}</p>`;
function rememberPair(value) {
  pair = value;
  try {
    sessionStorage.setItem("nb-pair", JSON.stringify(value));
  } catch {}
}
// Only navigation metadata enters history; drafts stay in this browser's memory.
let returnTarget = null;
history.replaceState(
  { nbDisplay: { scene: "loading", depth: 0 } },
  "",
  location.pathname,
);
function go(next, recordHistory = true) {
  clearTimeout(timer);
  clearInterval(celebrationTicker);
  const current = history.state?.nbDisplay;
  const step = ["me", "opponent", "score", "local", "otp"].includes(next);
  if (recordHistory) {
    if (!step && current?.depth) {
      returnTarget = next;
      history.go(-current.depth);
      return;
    }
    const state = {
      nbDisplay: {
        scene: next,
        depth: step ? (current?.depth || 0) + 1 : 0,
        flow: draft?.flow || "pair",
        index: draft?.index || 0,
      },
    };
    if (step) history.pushState(state, "", location.pathname);
    else history.replaceState(state, "", location.pathname);
  }
  scene = next;
  error = "";
  render();
  resetIdle();
  if (next === "board") playNext();
}
window.addEventListener("popstate", (event) => {
  if (returnTarget) {
    const target = returnTarget;
    returnTarget = null;
    history.replaceState(
      { nbDisplay: { scene: target, depth: 0 } },
      "",
      location.pathname,
    );
    go(target, false);
    return;
  }
  const state = event.state?.nbDisplay;
  if (draft && state?.flow === draft.flow) {
    if (state.scene === "score") loadGame(state.index, false);
    else go(state.scene, false);
  } else if (!snapshot && pair && ["local", "otp"].includes(state?.scene)) {
    go(state.scene, false);
  } else {
    history.replaceState(
      { nbDisplay: { scene: snapshot ? "board" : "pair", depth: 0 } },
      "",
      location.pathname,
    );
    go(snapshot ? "board" : "pair", false);
  }
});
function updateCountdown() {
  if (scene !== "celebrate") return;
  const seconds = Math.max(
    0,
    Math.ceil((celebration.endsAt - Date.now()) / 1000),
  );
  const label = root.querySelector("#celebration-countdown");
  if (label) label.textContent = `Back to board in ${seconds}s`;
  if (!seconds) go("board");
}
function updateBackButton() {
  document.querySelector("#entry-back").hidden =
    !document.fullscreenElement ||
    !["me", "opponent", "score", "local", "otp"].includes(scene);
  const fullscreen = document.querySelector("#fullscreen");
  const encourage = scene === "board" && !document.fullscreenElement;
  fullscreen.classList.toggle("prominent", encourage);
  fullscreen.textContent = document.fullscreenElement
    ? "Exit fullscreen"
    : encourage
      ? "Enter fullscreen"
      : "Fullscreen";
  fullscreen.setAttribute("aria-label", fullscreen.textContent);
}
function render() {
  updateBackButton();
  if (scene === "pair") {
    root.innerHTML = `<section class="pair enter"><div><h1>Activate display</h1><p class="pair-code">${esc(pair?.code || "")}</p><small id="pair-expiry"></small><p class="pair-address">${esc(location.host)}/activate</p>${button("Activate on this computer", "local", "primary")}</div><div class="pair-qr"><div class="qr"><img src="${esc(pair?.qr)}" alt="Scan to activate this display"></div><p>Scan to activate</p></div></section>${errorNode()}`;
    updateExpiry();
    return;
  }
  if (scene === "local" || scene === "otp") {
    root.innerHTML = `<section class="form enter"><h1>${scene === "local" ? "Activate display" : "Email code"}</h1><form id="local-form"><label for="local-value">${scene === "local" ? "Admin email" : "Six-digit code"}</label><input id="local-value" name="value" type="${scene === "local" ? "email" : "text"}" ${scene === "otp" ? 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"' : 'autocomplete="email"'} required>${button(scene === "local" ? "Send code" : "Activate", "submit-local", "primary", 'type="submit"')}${errorNode()}</form><p class="muted">Display access only. No personal login stays here.</p></section>`;
    root.querySelector("input").focus();
    return;
  }
  if (scene === "board") {
    if (!snapshot) return;
    const rows = rankRows(snapshot.standings),
      today = snapshot.matches.filter((m) => m.date === snapshot.today),
      results = today.length ? today : snapshot.matches.slice(0, 1);
    const visibleRows =
      innerWidth > 600
        ? Math.max(3, Math.min(8, Math.floor((innerHeight - 340) / 85)))
        : 8;
    const heading = new Date(
      snapshot.weekStart + "T12:00:00Z",
    ).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    root.innerHTML = `<section class="enter"><div class="board-heading"><h1>This week</h1><span class="muted">Week of ${heading}</span></div><div class="board"><section><div class="column-heading"><span>Player</span><span>W – L</span></div>${
      rows.length
        ? rows
            .slice(0, visibleRows)
            .map(
              (p) =>
                `<div class="standing" data-player="${p.id}"><span class="rank ${p.rank === 1 ? "lead" : ""}">${p.rank}</span>${avatar(person(p.id))}<span class="name">${esc(name(p.id))}</span><span class="record">${p.wins}–${p.losses}</span></div>`,
            )
            .join("")
        : '<p class="empty">First win is up for grabs.</p>'
    }</section><section><div class="column-heading"><span>${today.length ? "Today" : "Latest match"}</span></div>${
      results.length
        ? results
            .slice(0, 4)
            .map(
              (m) =>
                `<div class="result"><div><p>${esc(name(m.player1))} <small style="display:inline">vs</small> ${esc(name(m.player2))}</p><small>${m.games.map((g) => esc(gameLabel(g, [name(m.player1), name(m.player2)]))).join(" · ")}${m.date !== snapshot.today ? " · " + esc(m.date) : ""}</small></div><strong>${m.score1}–${m.score2}</strong></div>`,
            )
            .join("")
        : '<p class="empty">No matches yet.</p>'
    }</section></div><footer class="board-footer">${button("Record match", "record", "primary", snapshot.players.length < 2 ? "disabled" : "")}<span class="record-choice">or</span><div class="record-qr"><span class="qr"><img src="/api/v1/display/qr" alt="Scan to record a match on your phone"></span><span>Scan with your phone to record</span></div></footer>${errorNode()}</section>`;
    return;
  }
  if (scene === "me" || scene === "opponent") {
    const me = scene === "me";
    root.innerHTML = `<h1>${me ? "You?" : esc(name(draft.player1)) + " vs…"}</h1>${snapshot.players.length > 8 ? '<input class="player-search" type="search" placeholder="Find a player" aria-label="Find a player">' : ""}<div class="people enter">${snapshot.players
      .filter((p) => me || p.id !== draft.player1)
      .map(
        (p) =>
          `<button class="person" data-action="${me ? "choose-me" : "choose-opponent"}" data-id="${p.id}" data-name="${esc(p.name.toLowerCase())}">${avatar(p)}<span>${esc(p.name)}</span></button>`,
      )
      .join("")}</div>`;
    return;
  }
  if (scene === "score") {
    const g = draft.current,
      chosen = g.winner !== null,
      valid = chosen && g.points !== null,
      i = draft.index;
    const previous = draft.games.slice(0, i),
      wins = [0, 0];
    previous.forEach((g) => wins[gameWinner(g) - 1]++);
    if (valid) wins[g.winner]++;
    const finished = i > 0 && Math.max(...wins) === 2;
    root.innerHTML = `<section class="score-screen"><div class="game-chips">${previous.map((g, j) => `<button class="game-chip" data-action="edit-game" data-index="${j}">Game ${j + 1}: ${esc(gameLabel(g, [name(draft.player1), name(draft.opponent)]))}</button>`).join("")}</div><h1>${chosen ? "Game " + (i + 1) : "Who won game " + (i + 1) + "?"}</h1><div class="score-sides ${chosen ? "" : "compact"}">${[
      draft.player1,
      draft.opponent,
    ]
      .map((id, side) => {
        const editing = chosen && g.winner !== side,
          p = person(id),
          score = !chosen
            ? ""
            : g.type !== "exact"
              ? g.winner === side
                ? "W"
                : "L"
              : g.winner === side
                ? "11"
                : (g.points ?? "?");
        return `<section class="score-side ${editing ? "editing" : ""}" aria-label="${esc(p.name)}’s score"><button class="score-owner" data-action="winner" data-side="${side}" aria-pressed="${g.winner === side}" aria-label="${esc(p.name)} won game ${i + 1}">${avatar(p)}<span>${esc(p.name)}</span></button>${chosen ? `<div class="owned-score" aria-live="polite" aria-label="${esc(p.name)}: ${score}">${score}</div>` : ""}${editing ? `<div class="owned-keypad" aria-label="${esc(p.name)}’s points">${Array.from({ length: 10 }, (_, n) => `<button class="point" data-action="points" data-points="${n}" aria-label="${esc(p.name)}: ${n} points" aria-pressed="${g.type === "exact" && g.points === n}">${n}</button>`).join("")}</div><div class="score-alts"><button class="quiet" data-action="deuce" aria-pressed="${g.type === "deuce"}">${g.type === "deuce" ? "✓ " : ""}Deuce</button><button class="quiet" data-action="unrecorded" aria-pressed="${g.type === "unrecorded"}">${g.type === "unrecorded" ? "✓ " : ""}Score forgotten</button></div>` : ""}</section>`;
      })
      .join(
        "",
      )}</div><div class="actions">${button(finished ? "Record match · " + wins.join("–") : "Game " + (i + 2) + " →", finished ? "save" : "next-game", "primary", !valid || draft.saving ? "disabled" : "")}</div>${i === 0 && valid && !draft.states[1] ? button("Record single-game match", "save-single", "single", draft.saving ? "disabled" : "") : ""}${errorNode()}</section>`;
  }
  if (scene === "celebrate") {
    const m = celebration.match,
      winner = m.score1 > m.score2 ? m.player1 : m.player2;
    root.innerHTML = `<section class="celebration"><div class="confetti" aria-hidden="true">${Array.from({ length: 36 }, (_, i) => `<i style="left:${3 + ((i * 17) % 94)}%;top:${8 + ((i * 13) % 50)}%;animation-delay:${(i % 9) * 0.055}s"></i>`).join("")}</div>${avatar(person(winner))}<h1>${esc(name(winner))} wins 🎉</h1><p class="versus">${esc(name(m.player1))} vs ${esc(name(m.player2))}</p><div class="final-score">${m.score1}–${m.score2}</div>${m.date !== snapshot.today ? `<small>${esc(m.date)}</small>` : ""}<div class="game-results">${m.games.map((g) => `<span>${esc(gameLabel(g, [name(m.player1), name(m.player2)]))}</span>`).join("")}</div>${celebration.newLeader ? '<p class="leader">New weekly leader</p>' : ""}<small class="celebration-countdown" id="celebration-countdown" role="timer" aria-live="off">Back to board in 30s</small></section>`;
  }
}
function updateExpiry() {
  const el = document.querySelector("#pair-expiry");
  if (!el || !pair) return;
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(pair.expiresAt) - Date.now()) / 1000),
  );
  el.textContent = seconds
    ? "Expires in " +
      Math.floor(seconds / 60) +
      ":" +
      String(seconds % 60).padStart(2, "0")
    : "Code expired";
  if (!seconds) {
    el.innerHTML =
      '<button class="quiet" data-action="new-code">Get a new code</button>';
  }
}
function resetIdle() {
  clearTimeout(idle);
  clearTimeout(warning);
  if (!["me", "opponent", "score"].includes(scene)) return;
  notice.replaceChildren();
  warning = setTimeout(() => {
    notice.innerHTML =
      'Returning to board in 10 seconds. <button class="quiet" data-action="keep">Keep entering</button>';
  }, 110000);
  idle = setTimeout(() => {
    notice.replaceChildren();
    draft = null;
    go(snapshot ? "board" : "pair");
  }, 120000);
}
function loadGame(index, recordHistory = true) {
  draft.index = index;
  const g = draft.games[index];
  draft.current = draft.states[index]
    ? { ...draft.states[index] }
    : g
      ? g.type === "deuce" || g.type === "unrecorded"
        ? { winner: g.winner - 1, points: 0, type: g.type }
        : {
            winner: gameWinner(g) - 1,
            points: Math.min(g.score1, g.score2),
            type: "exact",
          }
      : { winner: null, points: null, type: "exact" };
  go("score", recordHistory);
}
function currentGame() {
  const g = draft.current;
  return g.type === "exact"
    ? {
        score1: g.winner === 0 ? 11 : g.points,
        score2: g.winner === 1 ? 11 : g.points,
      }
    : { type: g.type, winner: g.winner + 1 };
}
function changedGame() {
  const next = JSON.stringify(draft.current);
  if (JSON.stringify(draft.states[draft.index]) !== next)
    draft.key = crypto.randomUUID();
  draft.states[draft.index] = { ...draft.current };
  render();
}
function commitGame() {
  if (draft.current.winner !== null && draft.current.points !== null)
    draft.games[draft.index] = currentGame();
}
async function save(single = false) {
  if (draft.saving) return;
  commitGame();
  const games = draft.games.slice(0, single ? 1 : draft.index + 1);
  matchScore(games);
  draft.saving = true;
  error = "";
  render();
  root.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await api(
      "/display/matches",
      "POST",
      { player1: draft.player1, opponent: draft.opponent, games },
      draft.key,
    );
    draft = null;
    go("board");
    await poll();
  } catch (e) {
    if (e.status === 401) {
      draft = null;
      await setup();
    } else {
      draft.saving = false;
      error = e.message;
      render();
    }
  }
}
async function playNext() {
  if (scene !== "board" || !queue.length) return;
  const pending = queue.shift();
  scene = "preparing";
  try {
    const latest = await api("/display/match/" + pending.match.id);
    if (scene !== "preparing") {
      queue.unshift(pending);
      return;
    }
    celebration = {
      ...pending,
      match: latest,
      newLeader:
        pending.newLeader &&
        gameWinner({ score1: latest.score1, score2: latest.score2 }) ===
          gameWinner({
            score1: pending.match.score1,
            score2: pending.match.score2,
          }),
    };
    celebration.endsAt = Date.now() + 30000;
    go("celebrate");
    timer = setTimeout(() => go("board"), 30000);
    celebrationTicker = setInterval(updateCountdown, 1000);
  } catch (e) {
    if (scene === "preparing") {
      scene = "board";
      error = e.message;
      render();
    }
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (lastSuccess && Date.now() - lastSuccess > 120000) {
      cursor = null;
      queue = [];
    }
    const renew = Date.now() - lastRenew > 3600000;
    const params = new URLSearchParams({
      ...(version ? { version } : {}),
      ...(cursor !== null ? { cursor } : {}),
      ...(renew ? { renew: "1" } : {}),
    });
    const out = await api("/display/state?" + params);
    lastSuccess = Date.now();
    if (renew) lastRenew = Date.now();
    connection.textContent = "";
    if (!out.active) {
      if (!pair) {
        await newPair();
      }
      return;
    }
    const before = rankRows(snapshot?.standings || [])
      .filter((p) => p.rank === 1)
      .map((p) => p.id);
    const changed = !!out.snapshot;
    if (changed) snapshot = out.snapshot;
    const after = rankRows(snapshot?.standings || [])
      .filter((p) => p.rank === 1)
      .map((p) => p.id);
    version = out.version;
    cursor = out.cursor;
    for (const match of out.events) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      const winner =
        match.score1 > match.score2 ? match.player1 : match.player2;
      queue.push({
        match,
        newLeader:
          after.length === 1 && after[0] === winner && !before.includes(winner),
      });
    }
    if (seen.size > 500) seen = new Set([...seen].slice(-300));
    if (["loading", "pair", "local", "otp"].includes(scene)) {
      pair = null;
      try {
        sessionStorage.removeItem("nb-pair");
      } catch {}
      go("board");
      await requestWake();
    } else if (scene === "board" && changed) {
      const old = [...root.querySelectorAll("[data-player]")].map((el) => ({
        id: el.dataset.player,
        top: el.getBoundingClientRect().top,
      }));
      render();
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
        old.forEach((row) => {
          const el = root.querySelector(`[data-player="${row.id}"]`);
          if (el) {
            const dy = row.top - el.getBoundingClientRect().top;
            if (dy)
              el.animate(
                [
                  { transform: `translateY(${dy}px)` },
                  { transform: "translateY(0)" },
                ],
                { duration: 400, easing: "ease-out" },
              );
          }
        });
      await playNext();
    } else if (scene === "board") await playNext();
  } catch (e) {
    if (e.status === 401) {
      queue = [];
      seen.clear();
      draft = null;
      snapshot = null;
      version = null;
      cursor = null;
      await setup();
    } else {
      connection.textContent =
        "Reconnecting" +
        (lastSuccess
          ? " · " +
            new Date(lastSuccess).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "");
      if (scene === "loading") {
        error = e.message;
        root.innerHTML =
          "<h1>Connection unavailable</h1>" +
          button("Retry", "retry") +
          errorNode();
      }
    }
  } finally {
    polling = false;
  }
}
async function newPair() {
  rememberPair(await api("/display/pair", "POST", {}));
  go("pair");
}
async function setup() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("nb-pair") || "null");
    if (saved && Date.parse(saved.expiresAt) > Date.now()) {
      pair = saved;
      go("pair");
    } else await newPair();
  } catch (e) {
    error = e.message;
    root.innerHTML =
      "<h1>Couldn’t connect</h1>" + button("Retry", "retry") + errorNode();
  }
}
async function requestWake() {
  try {
    wake = await navigator.wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    updateCountdown();
    poll();
    if (snapshot) requestWake();
  }
});
root.addEventListener("input", (e) => {
  resetIdle();
  if (e.target.matches(".player-search"))
    root
      .querySelectorAll(".person")
      .forEach(
        (el) =>
          (el.hidden = !el.dataset.name.includes(e.target.value.toLowerCase())),
      );
});
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const action = el.dataset.action;
  if (el.tagName === "A") e.preventDefault();
  if (draft?.saving || returnTarget) return;
  resetIdle();
  try {
    if (action === "cancel") {
      if (draft?.saving) return;
      notice.replaceChildren();
      draft = null;
      go(snapshot ? "board" : "pair");
    } else if (action === "keep") resetIdle();
    else if (action === "retry") await poll();
    else if (action === "new-code") await newPair();
    else if (action === "local") go("local");
    else if (action === "record") {
      draft = {
        games: [],
        states: [],
        key: crypto.randomUUID(),
        flow: crypto.randomUUID(),
      };
      go("me");
    } else if (action === "choose-me") {
      draft.player1 = el.dataset.id;
      if (draft.opponent === draft.player1) draft.opponent = null;
      draft.games = [];
      draft.states = [];
      go("opponent");
    } else if (action === "choose-opponent") {
      draft.opponent = el.dataset.id;
      draft.games = [];
      draft.states = [];
      loadGame(0);
    } else if (action === "winner") {
      draft.current.winner = Number(el.dataset.side);
      changedGame();
    } else if (action === "points") {
      draft.current.points = Number(el.dataset.points);
      draft.current.type = "exact";
      changedGame();
    } else if (action === "deuce" || action === "unrecorded") {
      draft.current.type = action;
      draft.current.points = 0;
      changedGame();
    } else if (action === "next-game") {
      commitGame();
      loadGame(draft.index + 1);
    } else if (action === "edit-game") {
      commitGame();
      loadGame(Number(el.dataset.index));
    } else if (action === "save" || action === "save-single")
      await save(action === "save-single");
  } catch (e) {
    error = e.message;
    render();
  }
});
root.addEventListener("submit", async (e) => {
  if (e.target.id !== "local-form") return;
  e.preventDefault();
  const value = e.target.elements.value.value,
    submit = e.target.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    if (scene === "local") {
      const out = await api("/display/local/request", "POST", { email: value });
      pair.email = out.email;
      go("otp");
    } else {
      await api("/display/local/verify", "POST", {
        email: pair.email,
        code: value,
        displayCode: pair.code,
      });
      await poll();
    }
  } catch (e) {
    error = e.message;
    const err = root.querySelector(".error");
    if (err) err.textContent = error;
    submit.disabled = false;
  }
});
document.querySelector("#entry-back").addEventListener("click", () => {
  if (draft?.saving || returnTarget) return;
  resetIdle();
  if (history.state?.nbDisplay?.depth) history.go(-1);
});
document.querySelector("#fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    await requestWake();
  } catch {
    connection.textContent = "Use your browser’s fullscreen control.";
  }
});
document.addEventListener("fullscreenchange", () => {
  updateBackButton();
});
setInterval(() => {
  updateExpiry();
  if (!document.hidden) poll();
}, 3000);
poll();
