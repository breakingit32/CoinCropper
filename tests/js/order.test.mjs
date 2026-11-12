// node tests/js/order.test.mjs — case order check
import { checkOrder, compareCoins, orderFields, readingOrder } from "../../web/order.js";

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };
const coin = (description, grade, cac = null) => ({ result: { coin: { description, grade }, grading: cac ? { cac } : null } });
const F = (d, g, cac) => orderFields(coin(d, g, cac));
const before = (a, b, what) => check(compareCoins(a, b) < 0, what);

// Rules
before(F("1909 S VDB 1C", "AU53 BN"), F("1834 10C", "MS63"), "cents before dimes (denomination first)");
before(F("1916 10C", "MS64"), F("1916-D 10C", "F15"), "Philadelphia before D (same date)");
before(F("1916-D 10C", "F15"), F("1917 10C", "VF20"), "date before grade");
before(F("1885-O $1", "MS64"), F("1885-O $1", "MS65"), "grade low to high");
before(F("1885-O $1", "MS64 DMPL"), F("1885-O $1", "MS64 PL"), "DMPL before PL (same grade)");
before(F("1885-O $1", "MS64 PL"), F("1885-O $1", "MS64"), "PL before non-PL (same grade)");
before(F("1885-O $1", "MS64", "Green"), F("1885-O $1", "MS64"), "CAC before non-CAC (same grade)");
before(F("1885-O $1", "MS64", "Gold"), F("1885-O $1", "MS64", "Green"), "CAC Gold before Green");
before(F("1885-O $1", "MS64"), F("1885-O $1", "MS64+"), "64 before 64+");
before(F("1909-S 1C", "MS64 RD"), F("1909-S 1C", "MS64 BN"), "RD before BN (same grade)");
before(F("1936 10C", "MS65"), F("1936 10C", "PR65"), "business strike before proof (same date)");
before(F("1880 3CN", "PF64 CAMEO"), F("1881 3CN", "PF 64"), "3CN by date");
before(F("1883 5C", "PF64 ULTRA CAMEO"), F("1883 5C", "PF64 CAMEO"), "Ultra Cameo before Cameo");
before(F("1909 S 1C", "AU53 BN"), F("1909 S VDB 1C", "AU53 BN"), "plain before variety (same date/mint)");
before(F("1900-O/CC S$1", "MS64"), F("1849 G$1", "MS60"), "silver dollars before gold dollars");
check(F("1885 O S1", "MS65").denom === "$1", "OCR 'S1' read as $1");

// Reading order: rows top to bottom, left to right (slightly uneven rows)
const ro = readingOrder([{ key: "b", x: 300, y: 105, w: 140, h: 200 }, { key: "a", x: 100, y: 100, w: 140, h: 200 },
  { key: "d", x: 300, y: 320, w: 140, h: 200 }, { key: "c", x: 100, y: 310, w: 140, h: 200 }]).map((p) => p.key).join("");
check(ro === "abcd", `reading order ${ro}`);

// A case with two slabs swapped and one in the wrong row.
const C = {
  a: coin("1909 S VDB 1C", "AU53 BN"), b: coin("1916 10C", "MS64"), c: coin("1916-D 10C", "F15"),
  d: coin("1917 10C", "VF20"), e: coin("1834 10C", "MS63"), f: coin("1885-O $1", "MS64 PL"), g: coin("1885-O $1", "MS64"),
};
// laid out: row1: a c b d   row2: e g f      (correct: a e b c d f g)
const pos = { a: [0, 0], c: [1, 0], b: [2, 0], d: [3, 0], e: [0, 1], g: [1, 1], f: [2, 1] };
const slabs = Object.entries(pos).map(([key, [cx, r]]) => ({ key, x: 100 + cx * 150, y: 100 + r * 210, w: 140, h: 200 }));
const res = checkOrder(slabs, (k) => orderFields(C[k]));
const wrong = [...res.items].filter(([, v]) => v.ok === false).map(([k]) => k).sort().join("");
check(res.wrong === 3 && res.total === 7, `3 of 7 slabs flagged (${wrong})`);
check(res.items.get("e").ok === false && res.items.get("e").after === "1909 S VDB 1C · AU53 BN",
  `1834 dime: move after the 1909-S VDB (${res.items.get("e").after})`);
check(res.items.get("a").ok && res.items.get("d").ok && res.items.get("a").pos === 1, "slabs already in place are marked OK, with positions");
const unk = checkOrder([...slabs, { key: "z", x: 550, y: 310, w: 140, h: 200 }], (k) => (k === "z" ? null : orderFields(C[k])));
check(unk.unknown === 1 && unk.items.get("z").known === false && unk.wrong === 3, "unreadable slab is skipped, not counted wrong");

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
