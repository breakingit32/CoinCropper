// node tests/js/pcgsindex.test.mjs — NGC label text -> PCGS # from the offline index
import { matchLabel } from "../../web/pcgsindex.js";

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };

// Entries shaped like the PCGS API's (GetCoinFactsByGrade) answers.
const INDEX = {
  "2425": { name: "1909-S VDB 1C, BN", y: 1909, d: "1C", m: "S", g: "BN", v: "VDB", s: "Lincoln Cents 1909-1958" },
  "2426": { name: "1909-S VDB 1C, RB", y: 1909, d: "1C", m: "S", g: "RB", v: "VDB", s: "Lincoln Cents 1909-1958" },
  "2427": { name: "1909-S VDB 1C, RD", y: 1909, d: "1C", m: "S", g: "RD", v: "VDB", s: "Lincoln Cents 1909-1958" },
  "2431": { name: "1909-S 1C, BN", y: 1909, d: "1C", m: "S", g: "BN", s: "Lincoln Cents 1909-1958" },
  "2433": { name: "1909-S 1C, RD", y: 1909, d: "1C", m: "S", g: "RD", s: "Lincoln Cents 1909-1958" },
  "2429": { name: "1908-S 1C, RD", y: 1908, d: "1C", m: "S", g: "RD", s: "Indian Cents 1859-1909" },
  "2280": { name: "1877 1C, RB", y: 1877, d: "1C", m: "P", g: "RB", s: "Indian Cents 1859-1909" },
  "2382": { name: "1877 1C, PR RB", y: 1877, d: "1C", m: "P", g: "RB", s: "Indian Cents Proof" },
  "7373": { name: "1928 $1", y: 1928, d: "$1", m: "P", s: "Peace Dollars 1921-1935" },
  "4908": { name: "1916-D 10C", y: 1916, d: "10C", m: "D", s: "Mercury Dimes 1916-1945" },
  "4909": { name: "1916-D 10C, FB", y: 1916, d: "10C", m: "D", g: "FB", s: "Mercury Dimes 1916-1945" },
  "3980": { name: "1937-D 5C 3 Legs", y: 1937, d: "5C", m: "D", v: "3 Legs", s: "Buffalo Nickels" },
  "3976": { name: "1937-D 5C", y: 1937, d: "5C", m: "D", s: "Buffalo Nickels" },
  "_missing": ["1"],
};
const T = [
  ["1909 S VDB 1C", "AU55 BN", "2425", "1909-S VDB AU55 BN"],
  ["1909 S VDB 1C", "MS65 RB", "2426", "1909-S VDB MS65 RB"],
  ["1908 S 1C", "MS66 RD", "2429", "1908-S MS66 RD"],
  ["1877 1C", "PF64 RB", "2382", "1877 proof (not the business strike)"],
  ["1877 1C", "MS62 RB", "2280", "1877 business strike"],
  ["1928 $1", "AU58", "7373", "1928 Peace dollar"],
  ["1885 O S1", "MS65", null, "coin not in the index: no match"],
  ["1916 D 10C", "F15", "4908", "1916-D dime (plain, not FB)"],
  ["1937 D 3 LEGS 5C", "XF45", "3980", "1937-D 3 Legs"],
];
for (const [description, grade, want, what] of T) {
  const r = matchLabel(INDEX, { description, grade });
  check((r?.pcgs_no ?? null) === want, `${what}: ${r ? `PCGS #${r.pcgs_no} (${r.name})` : "no match"}`);
}
// Real PCGS answers: proofs share the business strike's name (later number),
// and a colour missing from the table is worked out from its siblings.
const REAL = {
  "2127": { name: "1877 1C, BN", y: 1877, d: "1C", m: "P", g: "BN", s: "Indian Cents 1859-1909" },
  "2128": { name: "1877 1C, RB", y: 1877, d: "1C", m: "P", g: "RB", s: "Indian Cents 1859-1909" },
  "2318": { name: "1877 1C, BN", y: 1877, d: "1C", m: "P", g: "BN", s: "Indian Cents 1859-1909" },
  "2319": { name: "1877 1C, RB", y: 1877, d: "1C", m: "P", g: "RB", s: "Indian Cents 1859-1909" },
  "2232": { name: "1908-S 1C, BN", y: 1908, d: "1C", m: "S", g: "BN", s: "Indian Cents 1859-1909" },
  "2233": { name: "1908-S 1C, RB", y: 1908, d: "1C", m: "S", g: "RB", s: "Indian Cents 1859-1909" },
};
check(matchLabel(REAL, { description: "1877 1C", grade: "PF 64 RB" })?.pcgs_no === "2319", "1877 proof RB -> 2319 (later number of the pair)");
check(matchLabel(REAL, { description: "1877 1C", grade: "MS 62 RB" })?.pcgs_no === "2128", "1877 business RB -> 2128");
const inf = matchLabel(REAL, { description: "1908 S 1C", grade: "MS 66 RD" });
check(inf?.pcgs_no === "2234" && inf.inferred, `1908-S RD not listed: worked out as 2234 (${inf?.name})`);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
