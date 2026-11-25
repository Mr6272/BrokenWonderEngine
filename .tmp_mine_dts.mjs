import { readFileSync } from "node:fs";
const d = readFileSync("web/src/js/bwe.d.ts", "utf8").split(/\r?\n/);
const i = d.findIndex((l) => /interface Mine\b/.test(l));
console.log(i < 0 ? "no Mine interface" : d.slice(i - 1, i + 95).map((l, k) => (i + k) + "| " + l).join("\n"));
