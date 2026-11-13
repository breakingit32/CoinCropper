// node tests/js/ngc.test.mjs — NGC slab -> PCGS # via NGC coin ID (web/ngc-pcgs.json)
import fs from "node:fs";
import { coinIdFromBarcode, coinIdFromPage, makeNgc } from "../../web/ngc.js";

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

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
