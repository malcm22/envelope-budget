// Plaid calls this when new transactions are ready. It only triggers a sync with the stored
// bank token, so a forged call can't inject data. Also used by the daily backup sync.
import { admin, cors, getConfig, json, syncItem } from "./core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  const body = await req.json().catch(() => ({}));
  try {
    if (body.sync_all) {
      if (!body.key || body.key !== await getConfig(db, "hmac_secret")) return json({ error: "forbidden" }, 403);
      const { data: items } = await db.from("plaid_items").select("*");
      for (const it of items || []) { try { await syncItem(db, it); } catch (e) { console.error(it.item_id, (e as Error).message); } }
      return json({ ok: true, items: items?.length || 0 });
    }
    if (body.webhook_type === "TRANSACTIONS" && body.item_id) {
      const { data: item } = await db.from("plaid_items").select("*").eq("item_id", body.item_id).maybeSingle();
      if (item) await syncItem(db, item);
    } else if (body.webhook_type === "ITEM" && body.item_id) {
      await db.from("plaid_items").update({ last_error: `${body.webhook_code}${body.error?.error_message ? ": " + body.error.error_message : ""}` }).eq("item_id", body.item_id);
    }
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ ok: false }, 200);
  }
});
