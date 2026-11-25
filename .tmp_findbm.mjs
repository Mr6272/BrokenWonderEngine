import { readFileSync, readdirSync } from "node:fs";
const files = readdirSync("src/Studio/runtime").filter((f) => f.endsWith(".java"));
let hits = [];
for (const f of files) {
  const s = readFileSync("src/Studio/runtime/" + f, "utf8");
  if (/buildMine\s*\(\)\s*\{/.test(s)) {
    const L = s.split(/\r?\n/);
    const i = L.findIndex((l) => /void buildMine\s*\(\)/.test(l));
    hits.push("### " + f + " buildMine @" + (i+1));
    hits.push(L.slice(i, i + 80).map((l, k) => (i + 1 + k) + "| " + l.slice(0, 175)).join("\n"));
  }
}
console.log(hits.join("\n") || "buildMine not found in src/Studio/runtime");
