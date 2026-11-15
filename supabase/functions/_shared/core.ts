// Shared server logic: Plaid calls, transaction sync, balances, and push notifications.
// Copied into each function folder at deploy time (Supabase deploys each function on its own).
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

// ---------- Plaid ----------
const PLAID_HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};
export async function plaid(path: string, body: Record<string, unknown>) {
  const env = (Deno.env.get("PLAID_ENV") || "production").toLowerCase();
  const res = await fetch((PLAID_HOSTS[env] || PLAID_HOSTS.production) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: Deno.env.get("PLAID_CLIENT_ID"), secret: Deno.env.get("PLAID_SECRET"), ...body }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error_message || data.error_code || "Plaid error") as Error & { code?: string };
    err.code = data.error_code;
    throw err;
  }
  return data;
}

export async function getConfig(db: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await db.from("server_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// ---------- household data ----------
type Doc = Record<string, any>;
type House = { cfg: Doc; cats: Record<string, Doc>; txns: Record<string, Doc>; pays: Record<string, Doc>; moves: Record<string, Doc> };

export async function loadHouse(db: SupabaseClient, hid: string): Promise<House> {
  const h: House = { cfg: {}, cats: {}, txns: {}, pays: {}, moves: {} };
  let from = 0;
  for (;;) {
    const { data, error } = await db.from("docs").select("coll,id,data").eq("household_id", hid).range(from, from + 999);
    if (error) throw error;
    for (const r of data || []) {
      if (r.coll === "config" && r.id === "main") h.cfg = r.data;
      else if (r.coll in h && r.coll !== "cfg") (h as any)[r.coll][r.id] = r.data;
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return h;
}

export function balances(h: House) {
  const b: Record<string, number> = {};
  for (const k in h.cats) b[k] = 0;
  for (const p of Object.values(h.pays)) { if (p.void) continue; for (const [c, a] of Object.entries(p.allocs || {})) if (c in b) b[c] += a as number; }
  for (const m of Object.values(h.moves)) {
    if (m.void) continue; const a = m.amount || 0;
    if (m.from in b) b[m.from] -= a;
    if (m.to in b) b[m.to] += a;
  }
  for (const t of Object.values(h.txns)) { if (t.void || !t.cat || !(t.cat in b)) continue; b[t.cat] -= (t.amount || 0) * (t.refund ? -1 : 1); }
  return b;
}

const money = (c: number) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s: string) => (s || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const tidy = (s: string) => (s || "Purchase").replace(/\s+/g, " ").trim().replace(/\b([A-Z])([A-Z']+)\b/g, (_m, a, b) => a + b.toLowerCase());

function billMatch(h: House, text: string): string | null {
  const d = (text || "").toUpperCase();
  for (const [k, c] of Object.entries(h.cats)) {
    if (c.archived || c.kind !== "bill" || !c.match) continue;
    for (const w of String(c.match).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)) if (d.includes(w)) return k;
  }
  return null;
}
function personFor(h: House, text: string): string {
  const people = (h.cfg.people || []) as Doc[];
  for (const p of people) if (p.last4 && String(p.last4).length === 4 && (text || "").includes(String(p.last4))) return p.key;
  return "";
}
function lastBucketFor(h: House, merchant: string): string | null {
  let best: Doc | null = null, bestId: string | null = null;
  for (const t of Object.values(h.txns)) {
    if (t.void || !t.cat || t.merchant !== merchant || !h.cats[t.cat] || h.cats[t.cat].archived) continue;
    if (!best || (t.at || 0) > (best.at || 0)) { best = t; bestId = t.cat; }
  }
  return bestId;
}

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function quickToken(db: SupabaseClient, hid: string, txn: string, cat: string) {
  return hmac((await getConfig(db, "hmac_secret"))!, `${hid}|${txn}|${cat}`);
}

// ---------- push ----------
export async function notify(db: SupabaseClient, hid: string, personKey: string, payload: Doc) {
  const [pub, priv, appUrl] = await Promise.all([getConfig(db, "vapid_public"), getConfig(db, "vapid_private"), getConfig(db, "app_url")]);
  if (!pub || !priv) return 0;
  webpush.setVapidDetails(appUrl && appUrl.startsWith("https://") ? appUrl : "mailto:noreply@example.com", pub, priv);
  let q = db.from("push_subs").select("*").eq("household_id", hid);
  if (personKey) q = q.eq("person_key", personKey);
  let { data: subs } = await q;
  if (personKey && (!subs || !subs.length)) ({ data: subs } = await db.from("push_subs").select("*").eq("household_id", hid));
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400, urgency: "high" });
      sent++;
    } catch (e: any) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", e?.statusCode, e?.body || e?.message);
    }
  }
  return sent;
}

// ---------- transaction sync ----------
export async function syncItem(db: SupabaseClient, item: Doc, opts: { quiet?: boolean } = {}) {
  const hid = item.household_id as string;
  let cursor: string | null = item.cursor ?? null;
  const added: Doc[] = [], modified: Doc[] = [], removed: Doc[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    added.length = modified.length = removed.length = 0;
    let c = cursor, more = true;
    try {
      while (more) {
        const r = await plaid("/transactions/sync", { access_token: item.access_token, cursor: c ?? undefined, count: 500, options: { include_original_description: true } });
        added.push(...r.added); modified.push(...r.modified); removed.push(...r.removed);
        c = r.next_cursor; more = r.has_more;
      }
      cursor = c; break;
    } catch (e: any) {
      if (e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < 2) continue;
      await db.from("plaid_items").update({ last_error: `${e.code || ""} ${e.message}`.trim(), last_sync: new Date().toISOString() }).eq("item_id", item.item_id);
      throw e;
    }
  }

  const h = await loadHouse(db, hid);
  const start = String(item.start_date);
  const bal = balances(h);
  const secret = await getConfig(db, "hmac_secret");
  const now = Date.now();
  const toNotify: { id: string; t: Doc }[] = [];
  const upserts: Doc[] = [];
  const deletes: string[] = [];
  const voidBills: string[] = [];

  for (const tx of [...added, ...modified]) {
    if (!(tx.amount > 0)) continue; // money coming in (pay, overtime, refunds from bank) is ignored
    const date = tx.authorized_date || tx.date;
    if (!date || date < start) continue;
    const id = "plaid-" + tx.transaction_id;
    const text = [tx.original_description, tx.name, tx.merchant_name].filter(Boolean).join(" ");
    const merchant = norm(tx.merchant_name || tx.name);
    const base = { date, amount: Math.round(tx.amount * 100), desc: tidy(tx.merchant_name || tx.name), merchant, pending: !!tx.pending, source: "bank", account: tx.account_id, raw: tx.original_description || tx.name || "" };
    const existing = h.txns[id];
    if (existing) { upserts.push({ id, data: { ...existing, ...base } }); h.txns[id] = { ...existing, ...base }; continue; }
    let carried: Doc | null = null;
    if (tx.pending_transaction_id && h.txns["plaid-" + tx.pending_transaction_id]) {
      carried = h.txns["plaid-" + tx.pending_transaction_id];
      deletes.push("plaid-" + tx.pending_transaction_id);
      delete h.txns["plaid-" + tx.pending_transaction_id];
    }
    const person = carried?.person ?? personFor(h, text);
    let cat: string | null = carried?.cat ?? null;
    let bill = false;
    if (!carried) { const bm = billMatch(h, text); if (bm) { cat = bm; bill = true; } }
    const data = { ...base, person, cat, at: carried?.at ?? now };
    upserts.push({ id, data });
    h.txns[id] = data;
    if (bill && cat) voidBills.push(cat + "|" + date.slice(0, 7));
    if (!carried && !cat) toNotify.push({ id, t: data });
  }
  for (const r of removed) {
    const id = "plaid-" + r.transaction_id;
    if (h.txns[id] && !deletes.includes(id)) { deletes.push(id); delete h.txns[id]; }
  }
  // A real bill charge replaces that month's scheduled/estimated entry.
  for (const key of voidBills) {
    const [cat, ym] = key.split("|");
    for (const [id, t] of Object.entries(h.txns)) {
      if (t.source === "autopay" && t.cat === cat && !t.void && String(t.date).slice(0, 7) === ym) upserts.push({ id, data: { ...t, void: true, replaced: true } });
    }
  }

  if (upserts.length) {
    const rows = upserts.map((u) => ({ household_id: hid, coll: "txns", id: u.id, data: u.data, updated_at: new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 200) { const { error } = await db.from("docs").upsert(rows.slice(i, i + 200)); if (error) throw error; }
  }
  if (deletes.length) await db.from("docs").delete().eq("household_id", hid).eq("coll", "txns").in("id", deletes);
  await db.from("plaid_items").update({ cursor, last_sync: new Date().toISOString(), last_error: null }).eq("item_id", item.item_id);

  let sent = 0;
  if (!opts.quiet && secret) {
    for (const { id, t } of toNotify.slice(0, 10)) {
      const guess = lastBucketFor(h, t.merchant);
      const payload: Doc = {
        title: `${money(t.amount)} at ${t.desc}`,
        body: guess ? `Which bucket? ${h.cats[guess].name} has ${money(bal[guess] ?? 0)} left.` : "Which bucket was this for? Tap to pick.",
        t: id, h: hid,
      };
      if (guess) payload.q = { c: guess, n: h.cats[guess].name, s: await hmac(secret, `${hid}|${id}|${guess}`) };
      sent += await notify(db, hid, t.person, payload);
    }
  }
  return { added: upserts.length, removed: deletes.length, notified: sent };
}
