// node tests/js/ngc.test.mjs — NGC slab -> PCGS # via NGC coin ID (web/ngc-pcgs.json)
import fs from "node:fs";
import { coinIdFromBarcode, coinIdFromPage, makeNgc } from "../../web/ngc.js";
import { idsFromAnswer, makeNgcApi } from "../../web/ngcapi.js";

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };
const map = JSON.parse(fs.readFileSync(new URL("../../web/ngc-pcgs.json", import.meta.url), "utf8"));

check(Object.keys(map).length > 15000 && map["17373"] === "7373" && map["14908"] === "4908" && map["13980"] === "3980",
  "table loaded: 1928 $1, 1916-D 10C, 1937-D 3 Legs 5C");
check(coinIdFromBarcode("644963100417373", "6449631-004", map) === "17373", "coin ID after the cert in the barcode");
check(coinIdFromBarcode("1737364496310045", "6449631-004", map) === "17373", "coin ID before the cert (grade digits after)");
check(coinIdFromBarcode("6449631004", "6449631-004", map) === null, "barcode with only the cert: no guess");
check(coinIdFromBarcode("123456789", "6449631-004", map) === null, "barcode not containing the cert: no guess");
check(coinIdFromPage("<tr><td>NGC Coin ID</td><td>17373</td></tr>") === "17373", "coin ID from the cert page text");
check(coinIdFromPage('<a href="/coin-explorer/united-states/dollars/peace-dollars-1921-1935/17373/">') === "17373", "coin ID from the coin explorer link");

const urls = [];
const ngc = makeNgc({ storage: null, fetchMap: async () => map,
  http: async (o) => { urls.push(o.url); return { status: 200, data: o.url.endsWith("/certlookup/6449631-004/58/") ? "NGC Coin ID: 17373" : "" }; } });
const r = await ngc.pcgsFor({ cert: "6449631-004", raw: "6449631004", grade_num: 58 });
check(r?.pcgs_no === "7373" && r.via === "NGC cert lookup" && urls[0] === "https://www.ngccoin.com/certlookup/6449631-004/58/",
  `cert page used when the barcode has no coin ID (${JSON.stringify(r)})`);
const blocked = makeNgc({ storage: null, fetchMap: async () => map, http: async () => ({ status: 403, data: "Cloudflare" }) });
check(await blocked.pcgsFor({ cert: "6449631-004", raw: "", grade_num: 58 }) === null, "blocked cert page: no match, no error");

// NGC dealer API
check(idsFromAnswer({ data: { certNumber: "6849356-007", NGCCoinID: 13980, description: "1937-D 5C 3 Legs" } })?.ngc_id === "13980", "coin ID found in an API answer");
check(idsFromAnswer({ cert: { coin: { CoinId: "17373", PCGSNo: "7373" } } })?.pcgs_no === "7373", "PCGS # used when the answer has one");
check(idsFromAnswer({ status: "not found" }) === null, "answer without IDs: nothing");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const expired = `x.${b64({ exp: 1790000000, azp: "CLIENT" })}.y`;   // Oct 2026
const calls = [];
const apiHttp = async (o) => {
  calls.push(o.method + " " + o.url);
  if (o.url.includes("login.collectiblesgroup.com")) {
    return o.data.password === "pw" && o.data.client_id === "CLIENT"
      ? { status: 200, data: { access_token: "FRESH", expires_in: 86400 } } : { status: 403, data: { error: "invalid_grant", error_description: "Wrong email or password." } };
  }
  if (o.headers.Authorization !== "Bearer FRESH") return { status: 401, data: { message: "Unauthorized" } };
  return { status: 200, data: { coin: { NGCCoinID: "13980" } } };
};
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const base = { ngcCertUrl: "https://dealer-api.example/certs/{cert}?grade={grade}", ngcToken: expired };
const api = makeNgcApi({ http: apiHttp, storage: mem(), getSettings: () => ({ ...base, ngcUser: "me@x.com", ngcPass: "pw" }) });
const a1 = await api.lookup("6849356-007", 45);
const a2 = await api.lookup("6849356-007", 45);
check(a1?.ngc_id === "13980" && calls.filter((c) => c.includes("login")).length === 1, "logs in once, token reused");
check(calls.some((c) => c.endsWith("/certs/6849356-007?grade=45")), "cert address filled in");
let e1 = null; try { await makeNgcApi({ http: apiHttp, storage: mem(), getSettings: () => base }).lookup("6849356-007", 45); } catch (e) { e1 = e.message; }
check(/NGC token expired/.test(e1 || ""), `expired pasted token: ${e1}`);
let e2 = null; try { await makeNgcApi({ http: apiHttp, storage: mem(), getSettings: () => ({ ...base, ngcUser: "me@x.com", ngcPass: "bad" }) }).lookup("1", 45); } catch (e) { e2 = e.message; }
check(/NGC login refused: Wrong email or password/.test(e2 || ""), `wrong password: ${e2}`);
const viaApi = makeNgc({ storage: null, fetchMap: async () => map, http: async () => ({ status: 403, data: "" }), api });
const r3 = await viaApi.pcgsFor({ cert: "6849356-007", raw: "", grade_num: 45 });
check(r3?.pcgs_no === "3980" && r3.via === "NGC API", `NGC slab -> NGC API coin ID -> PCGS #${r3?.pcgs_no}`);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
