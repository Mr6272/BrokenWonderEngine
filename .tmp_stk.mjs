import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const A = rd("src/Studio/runtime/ScriptApi.java").split(/\r?\n/);
const i = A.findIndex((l) => /"modeIndex"/.test(l));
console.log("modeIndex at " + (i+1));
const out = [];
for (let k = Math.max(0, i - 45); k < Math.min(A.length, i + 20); k++) {
  const t = A[k].trim();
  if (/^\*|^\/\*\*|^\/\//.test(t)) continue;
  out.push((k+1) + "| " + A[k].replace(/\s+$/, "").slice(0, 170));
}
console.log(out.join("\n"));
