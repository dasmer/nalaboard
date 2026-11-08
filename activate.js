import { api, esc, returnToDisplay } from "./display-client.mjs";
const root = document.querySelector("#screen");
let code = new URLSearchParams(location.search).get("code") || "",
  identity,
  step = "code",
  email = "",
  error = "",
  busy = false;
const button = (label, action, cls = "primary") =>
  `<button class="action ${cls}" data-action="${action}" ${busy ? "disabled" : ""}>${label}</button>`;
function render() {
  const manage = location.hash === "#displays";
  let content = "";
  if (step === "done")
    content = `<h1>Display activated</h1>${identity.local ? button("Open scoreboard", "display") : button("Done", "home")}<p class="muted">${identity.local ? "Display access only." : "You’re still signed in."}</p>`;
  else if (step === "code")
    content = `<h1>${manage ? "Office displays" : "Activate display"}</h1><form data-form="code"><label for="code">Display code</label><input id="code" name="code" value="${esc(code)}" autocapitalize="characters" autocomplete="off" required>${button("Continue", "submit")}</form>`;
  else if (step === "email")
    content = `<h1>${manage ? "Office displays" : "Activate display"}</h1><form data-form="email"><label for="email">${identity.local ? "Admin email" : "Email"}</label><input id="email" name="email" type="email" autocomplete="email" required>${button("Send code", "submit")}</form>${identity.local ? '<p class="muted">Display access only. No personal login stays here.</p>' : ""}`;
  else if (step === "otp")
    content = `<h1>Email code</h1><form data-form="otp"><label for="otp">Six-digit code</label><input id="otp" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>${button(identity.local ? "Activate" : "Continue", "submit")}</form>`;
  else if (step === "approve")
    content = `<h1>Activate display?</h1><p class="pair-code">${esc(code)}</p><p class="account-name">${esc(identity.user.name)}</p>${button("Activate", "approve")}`;
  else if (step === "denied")
    content =
      '<h1>Admin access required</h1><p class="muted">Ask Benjamin or Susanna to activate this display.</p><button class="quiet" data-action="signout">Use another account</button>';
  root.innerHTML = `<section class="form enter">${content}<p class="error" role="alert">${esc(error)}</p></section>`;
  root.querySelector("input")?.focus();
}
async function identify() {
  identity = await api(
    "/display/identity" + (code ? "?code=" + encodeURIComponent(code) : ""),
  );
  if (!identity.user) {
    step = "email";
    render();
  } else if (!identity.admin) {
    step = "denied";
    render();
  } else if (location.hash === "#displays") await list();
  else if (!code) {
    step = "code";
    render();
  } else {
    step = "approve";
    render();
  }
}
async function list() {
  const out = await api("/displays");
  step = "list";
  root.innerHTML = `<section class="display-list"><h1>Office displays</h1>${out.displays.length ? out.displays.map((d) => `<div class="display-row"><div><h2>Office display</h2><p>${d.revoked_at ? "Disconnected" : "Last connected " + new Date(d.last_seen_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}</p></div>${d.revoked_at ? "" : `<button class="action" data-action="revoke" data-id="${d.id}">Disconnect</button>`}</div>`).join("") : '<p class="empty">No displays connected.</p>'}<a class="action" style="margin-top:25px" href="/activate">Activate a display</a><p class="error" role="alert"></p></section>`;
}
root.addEventListener("submit", async (e) => {
  if (!e.target.dataset.form) return;
  e.preventDefault();
  if (busy) return;
  busy = true;
  error = "";
  const f = e.target,
    b = Object.fromEntries(new FormData(f));
  f.querySelector("button").disabled = true;
  try {
    if (f.dataset.form === "code") {
      code = b.code.trim().toUpperCase();
      history.replaceState(
        null,
        "",
        "/activate?code=" + encodeURIComponent(code),
      );
      await identify();
    } else if (f.dataset.form === "email") {
      const out = await api(
        identity.local ? "/display/local/request" : "/auth/request",
        "POST",
        { email: b.email },
      );
      email = out.email;
      step = "otp";
    } else if (identity.local) {
      await api("/display/local/verify", "POST", {
        email,
        code: b.otp,
        displayCode: code,
      });
      step = "done";
    } else {
      await api("/auth/verify", "POST", { email, code: b.otp });
      await identify();
    }
  } catch (e) {
    error = e.message;
  } finally {
    busy = false;
    if (step !== "list") render();
  }
});
root.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || busy || el.dataset.action === "submit") return;
  const a = el.dataset.action;
  busy = true;
  el.disabled = true;
  try {
    if (a === "approve") {
      const out = await api("/display/approve", "POST", { code });
      identity.local = out.local;
      step = "done";
    } else if (a === "display") returnToDisplay();
    else if (a === "home") location.assign("/");
    else if (a === "signout") {
      await api("/auth/logout", "POST", {});
      await identify();
    } else if (a === "revoke") {
      await api("/displays/" + el.dataset.id, "DELETE");
      await list();
    }
  } catch (e) {
    error = e.message;
  } finally {
    busy = false;
    if (step !== "list") render();
    else if (error) root.querySelector(".error").textContent = error;
  }
});
(async () => {
  try {
    if (code || location.hash === "#displays") await identify();
    else render();
  } catch (e) {
    error = e.message;
    step = "code";
    render();
  }
})();
