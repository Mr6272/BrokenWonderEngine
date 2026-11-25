import { readFileSync } from "node:fs";
const d = readFileSync("web/src/js/bwe.d.ts", "utf8").split(/\r?\n/);
for (const name of ["Board", "TextInput"]) {
  const i = d.findIndex((l) => new RegExp("interface " + name + "\\b").test(l));
  console.log("=== " + name + " ===");
  if (i >= 0) console.log(d.slice(i, i + 30).map((l, k) => (i + 1 + k) + "| " + l).join("\n"));
}
const j = d.findIndex((l) => /interface Entity\b/.test(l));
console.log("=== Entity ===");
if (j >= 0) console.log(d.slice(j, j + 42).map((l, k) => (j + 1 + k) + "| " + l).join("\n"));
