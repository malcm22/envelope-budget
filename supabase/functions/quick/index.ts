// Lets the notification's quick button file a purchase into a bucket without opening the app.
// The button carries a signed token that only works for that one purchase and bucket.
import { admin, cors, json, quickToken } from "./core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { h, t, c, s } = await req.json();
    const db = admin();
    if (!h || !t || !c || !s || s !== await quickToken(db, h, t, c)) return json({ error: "bad token" }, 403);
    const { data: doc } = await db.from("docs").select("data").eq("household_id", h).eq("coll", "txns").eq("id", t).maybeSingle();
    if (!doc) return json({ error: "gone" }, 404);
    if (doc.data.cat) return json({ ok: true, already: true });
    await db.from("docs").update({ data: { ...doc.data, cat: c }, updated_at: new Date().toISOString() }).eq("household_id", h).eq("coll", "txns").eq("id", t);
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
