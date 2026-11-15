// Bank connection for the signed-in household: create a Link token, save the bank, sync now, disconnect.
import { admin, cors, json, notify, plaid, syncItem } from "./core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const db = admin();
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Please sign in again." }, 401);
    const body = await req.json().catch(() => ({}));
    const hid = body.hid as string;
    const { data: mem } = await db.from("members").select("user_id").eq("household_id", hid).eq("user_id", u.user.id).maybeSingle();
    if (!mem) return json({ error: "Not part of this budget." }, 403);

    if (body.action === "link_token") {
      const req2: Record<string, unknown> = {
        client_name: "Envelope Budget", language: "en", country_codes: ["US"],
        user: { client_user_id: u.user.id }, products: ["transactions"], transactions: { days_requested: 30 },
        webhook: `${Deno.env.get("SUPABASE_URL")}/functions/v1/plaid-webhook`,
      };
      if (Deno.env.get("PLAID_REDIRECT_URI")) req2.redirect_uri = Deno.env.get("PLAID_REDIRECT_URI");
      const r = await plaid("/link/token/create", req2);
      return json({ link_token: r.link_token });
    }

    if (body.action === "exchange") {
      const r = await plaid("/item/public_token/exchange", { public_token: body.public_token });
      const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start_date || "") ? body.start_date : new Date().toISOString().slice(0, 10);
      const { error } = await db.from("plaid_items").upsert({ item_id: r.item_id, household_id: hid, access_token: r.access_token, institution: body.institution || null, start_date: start, cursor: null });
      if (error) throw error;
      const { data: item } = await db.from("plaid_items").select("*").eq("item_id", r.item_id).single();
      let result = null;
      try { result = await syncItem(db, item, { quiet: true }); } catch (_e) { /* first sync can lag; the webhook will catch up */ }
      return json({ ok: true, institution: body.institution || null, result });
    }

    if (body.action === "sync") {
      const { data: items } = await db.from("plaid_items").select("*").eq("household_id", hid);
      const out = [];
      for (const it of items || []) { try { out.push(await syncItem(db, it)); } catch (e) { out.push({ error: (e as Error).message }); } }
      return json({ ok: true, results: out });
    }

    if (body.action === "unlink") {
      const { data: items } = await db.from("plaid_items").select("*").eq("household_id", hid);
      for (const it of items || []) { try { await plaid("/item/remove", { access_token: it.access_token }); } catch (_e) { /* already gone */ } }
      await db.from("plaid_items").delete().eq("household_id", hid);
      return json({ ok: true });
    }

    if (body.action === "test_push") {
      const sent = await notify(db, hid, body.person || "", { title: "Notifications are on ✓", body: "You'll get one like this for each card purchase.", t: "" });
      return json({ ok: true, sent });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
