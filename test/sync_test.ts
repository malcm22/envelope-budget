// Runs the real sync code against a fake bank and a fake database.
import { syncItem } from "../supabase/functions/_shared/core.ts";

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { docs: [], plaid_items: [], server_config: [{ key: "hmac_secret", value: "s3cret" }], push_subs: [] };
function q(table: string) {
  const f: [string, string, any][] = []; let op = "select", payload: any = null;
  const run = () => {
    let rows = tables[table].filter((r) => f.every(([k, o, v]) => o === "eq" ? r[k] === v : o === "in" ? v.includes(r[k]) : true));
    if (op === "delete") { tables[table] = tables[table].filter((r) => !rows.includes(r)); return { data: null, error: null }; }
    if (op === "update") { rows.forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
    return { data: rows, error: null };
  };
  const b: any = {
    select() { return b; }, eq(k: string, v: any) { f.push([k, "eq", v]); return b; }, in(k: string, v: any) { f.push([k, "in", v]); return b; },
    range() { return b; }, maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
    single() { return b.maybeSingle(); },
    delete() { op = "delete"; return b; }, update(p: any) { op = "update"; payload = p; return b; },
    upsert(rows: Row[]) { for (const r of [rows].flat()) { const i = tables[table].findIndex((x) => x.household_id === r.household_id && x.coll === r.coll && x.id === r.id); if (i >= 0) tables[table][i] = r; else tables[table].push(r); } return Promise.resolve({ error: null }); },
    then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
  };
  return b;
}
const db: any = { from: q };
const H = "h1";
const doc = (coll: string, id: string, data: Row) => tables.docs.push({ household_id: H, coll, id, data });
doc("config", "main", { people: [{ key: "p0", name: "Collin", last4: "4417" }, { key: "p1", name: "Jacee", last4: "8823" }] });
doc("cats", "gas", { name: "Gas", kind: "spend", perPay: 27500 });
doc("cats", "pw", { name: "Power", kind: "bill", billAmount: 26000, match: "CLARK PUD", perPay: 6000 });
doc("pays", "p1", { date: "2026-11-13", amount: 190000, allocs: { gas: 27500, pw: 6000 } });
doc("txns", "bill-pw-202611", { date: "2026-11-01", amount: 26000, cat: "pw", source: "autopay", estimate: true });
doc("txns", "old-gas", { date: "2026-11-10", amount: 5000, cat: "gas", merchant: "CHEVRON", at: 1 });
const item = { item_id: "it1", household_id: H, access_token: "tok", cursor: null, start_date: "2026-11-14" };
tables.plaid_items.push(item);

const pages: any[] = [
  { added: [
      { transaction_id: "a", amount: 64.18, date: "2026-11-14", name: "CHEVRON 0091", merchant_name: "Chevron", original_description: "PURCHASE AUTHORIZED ON 11/14 CHEVRON 0091 CARD 4417", pending: true },
      { transaction_id: "b", amount: 231.45, date: "2026-11-14", name: "CLARK PUD WEB PMT", original_description: "CLARK PUD WEB PMT", pending: false },
      { transaction_id: "c", amount: -1900, date: "2026-11-14", name: "PAYROLL DEPOSIT" },
      { transaction_id: "d", amount: 12, date: "2026-11-01", name: "OLD BEFORE START" },
      { transaction_id: "e", amount: 38.12, date: "2026-11-14", name: "TARGET 00027", original_description: "TARGET 00027 CARD 8823", pending: false },
    ], modified: [], removed: [], next_cursor: "c1", has_more: false },
  { added: [ { transaction_id: "a2", pending_transaction_id: "a", amount: 64.18, date: "2026-11-15", authorized_date: "2026-11-14", name: "CHEVRON 0091", merchant_name: "Chevron", pending: false } ],
    modified: [], removed: [{ transaction_id: "a" }], next_cursor: "c2", has_more: false },
];
let call = 0;
globalThis.fetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  if (String(url).endsWith("/transactions/sync")) { const p = pages[call++]; console.log("  plaid sync cursor:", body.cursor ?? "(start)"); return new Response(JSON.stringify(p), { status: 200 }); }
  return new Response("{}", { status: 404 });
}) as any;

const txns = () => Object.fromEntries(tables.docs.filter((r) => r.coll === "txns").map((r) => [r.id, r.data]));
const ok = (cond: boolean, msg: string) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) Deno.exitCode = 1; };

console.log("Round 1: new purchases arrive");
const r1 = await syncItem(db, item);
let t = txns();
ok(t["plaid-a"]?.person === "p0" && t["plaid-a"]?.cat === null, "Chevron matched to Collin's card (4417), waiting for a bucket");
ok(t["plaid-e"]?.person === "p1", "Target matched to Jacee's card (8823)");
ok(t["plaid-b"]?.cat === "pw" && t["plaid-b"]?.amount === 23145, "Clark PUD auto-filed under Power at the real $231.45");
ok(t["bill-pw-202611"]?.void === true, "Power's $260 estimate for November replaced by the real charge");
ok(!t["plaid-c"], "Payroll deposit ignored");
ok(!t["plaid-d"], "Purchase from before the bank was connected ignored");
ok(item.cursor === "c1", "Saved the bank's place for next time");
ok(r1.notified === 0, "No phones signed up in this test, so nothing sent (and no crash)");

console.log("Round 2: you pick Gas for the pending Chevron, then the bank posts it");
tables.docs.find((r) => r.id === "plaid-a")!.data.cat = "gas";
await syncItem(db, item);
t = txns();
ok(!t["plaid-a"] && t["plaid-a2"]?.cat === "gas" && t["plaid-a2"]?.person === "p0", "Posted charge kept your Gas pick and Collin's name; pending copy removed");
ok(t["plaid-a2"]?.date === "2026-11-14", "Uses the day you actually bought it");
