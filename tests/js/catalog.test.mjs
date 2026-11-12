// node tests/js/catalog.test.mjs — PCGS # for NGC slabs from the Greysheet catalog (fake catalog)
import { makeCatalog, wantedFromLabel } from "../../web/catalog.js";

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };

const node = (Id, Name, kids = 0, items = 0) => ({ Id, Name, NodeChildrenCountLive: kids, CollectibleChildrenCountLive: items });
const C = (Gsid, PcgsNumber, CoinDate, MintMark, Den, extra = {}) => ({ Gsid, PcgsNumber, CoinDate, MintMark, DenominationShort: Den,
  StrikeType: "Business", Name: `${CoinDate} ${Den}`, ...extra });
const TREE = {
  1: [node(10, "U.S. Coins", 4), node(11, "World Coins", 3), node(12, "U.S. Paper Money", 5)],
  10: [node(19, "Half Cents", 1), node(20, "Small Cents", 2), node(21, "Half Dimes", 1), node(22, "Dimes", 3), node(23, "Nickels", 1)],
  20: [node(40, "Lincoln Cents, Wheat Reverse (1909-1958)", 0, 3), node(41, "Indian Cents (1859-1909)", 0, 1)],
  21: [node(50, "Seated Half Dimes 1837-1873", 0, 1)],
  22: [node(30, "Capped Bust Dimes 1809-1837", 0, 2), node(31, "Mercury Dimes (1916-1945)", 0, 5), node(32, "Mercury Dimes, Proof", 0, 1)],
  23: [node(60, "Buffalo Nickels 1913-1938", 0, 2)],
};
const ITEMS = {
  30: [C(301, "4530", "1833", "", "10C"), C(302, "4532", "1834", "", "10C", { Variety: "" })],
  31: [C(310, "4905", "1916", "", "10C"), C(311, "4906", "1916", "", "10C", { Desg: "FB" }),
       C(312, "4908", "1916-D", "D", "10C"), C(313, "4909", "1916-D", "D", "10C", { Desg: "FB" }),
       C(314, "4917", "1917-S", "S", "10C", { Desg: "FB" })],
  32: [C(320, "5050", "1936", "", "10C", { StrikeType: "Proof" })],
  40: [C(400, "2425", "1909-S VDB", "S", "1C", { Variety: "VDB", Desg: "BN" }), C(401, "2426", "1909-S VDB", "S", "1C", { Variety: "VDB", Desg: "RB" }),
       C(402, "2428", "1909-S", "S", "1C", { Desg: "BN" })],
  41: [C(410, "2238", "1909-S", "S", "1C", { Desg: "BN" })],
  50: [C(500, "4400", "1834", "", "H10C")],
  60: [C(600, "3976", "1937-D", "D", "5C"), C(601, "3980", "1937-D", "D", "5C", { Variety: "3 Legs" })],
};
let calls = 0;
const http = async (o) => {
  calls++;
  const u = new URL(o.url);
  if (o.headers["x-api-key"] !== "K") return { status: 403, data: { PermitAccess: false, AccessDeniedMessage: "bad key" } };
  const id = +u.searchParams.get("NodeId");
  if (u.pathname.endsWith("/GetNodeRequest")) return { status: 200, data: { Data: [node(1, "Catalog", 3)] } };
  if (u.pathname.endsWith("/GetNodeChildrenRequest")) return { status: 200, data: { Data: TREE[id] || [] } };
  if (u.pathname.endsWith("/GetCollectibleByNodeRequest")) return { status: 200, data: { Data: ITEMS[id] || [] } };
  return { status: 404, data: {} };
};
const store = new Map();
const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
const cat = makeCatalog({ http, getKeys: () => ({ gsKey: "K", gsToken: "T" }), storage });

const w = wantedFromLabel({ description: "1937 D 3 LEGS 5C", grade: "XF45" });
check(w.year === "1937" && w.mint === "D" && w.denom === "5C" && w.variety === "3 LEGS" && !w.proof, `label parsed: ${JSON.stringify(w)}`);

const T = [
  ["1916 D 10C", "F15", "4908", "1916-D Mercury dime (plain, not FB)"],
  ["1917 S 10C", "MS64 FB", "4917", "1917-S Mercury dime Full Bands"],
  ["1834 10C", "MS63", "4532", "1834 Capped Bust dime (not the half dime)"],
  ["1909 S VDB 1C", "AU53 BN", "2425", "1909-S VDB cent BN (not RB, not plain 1909-S)"],
  ["1937 D 3 LEGS 5C", "XF45", "3980", "1937-D 3 Legs nickel (not the plain 1937-D)"],
];
for (const [description, grade, want, what] of T) {
  const r = await cat.lookup({ year: description.slice(0, 4), description, grade });
  check(r?.pcgs_no === want, `${what}: PCGS #${r?.pcgs_no} (${r?.name}, ${r?.node})`);
}
const before = calls;
const again = await cat.lookup({ year: "1916", description: "1916 D 10C", grade: "F15" });
check(again?.pcgs_no === "4908" && calls === before, "repeat lookup served from the phone's cache (no API calls)");
const none = await cat.lookup({ year: "1925", description: "1925 D 10C", grade: "MS65" });
check(none === null, "coin not in the catalog: no match rather than a wrong one");
const bad = makeCatalog({ http, getKeys: () => ({ gsKey: "X", gsToken: "T" }), storage: { getItem: () => null, setItem() {} } });
let err = null; try { await bad.lookup({ year: "1916", description: "1916 D 10C", grade: "F15" }); } catch (e) { err = e.message; }
check(/bad key/.test(err || ""), `refused key reported (${err})`);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
