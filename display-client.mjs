export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function api(
  path,
  method = "GET",
  body,
  key = crypto.randomUUID(),
) {
  const res = await fetch("/api/v1" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "Idempotency-Key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(out.error || "Try again."), {
      status: res.status,
    });
  return out;
}
export const avatar = (p) =>
  p.photo
    ? `<img class="avatar" src="/api/v1/photos/${esc(p.id)}" alt="">`
    : `<span class="avatar" aria-hidden="true">${esc(p.avatar || p.name[0])}</span>`;
export function rankRows(rows) {
  const sorted = [...rows].sort(
    (a, b) =>
      b.wins - a.wins ||
      a.losses - b.losses ||
      String(a.id).localeCompare(String(b.id)),
  );
  let rank = 0;
  return sorted.map((p, i) => {
    if (
      !i ||
      p.wins !== sorted[i - 1].wins ||
      p.losses !== sorted[i - 1].losses
    )
      rank = i + 1;
    return { ...p, rank };
  });
}
export const returnToDisplay = () => location.assign("/bigscreen");
