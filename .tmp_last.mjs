import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const skip = (t) => /^\*|^\/\*\*|^\/\//.test(t);
const M = rd("src/Studio/runtime/Minesweeper.java").split(/\r?\n/);
const i = M.findIndex((l) => /void paintCell\(/.test(l));
console.log("=== paintCell @" + (i+1) + " ===");
const o1 = [];
M.forEach((l, k) => { if (k >= i && k < i + 105 && !skip(l.trim())) o1.push((k+1)+"| "+l.replace(/\s+$/,"")); });
console.log(o1.join("\n"));

const A = rd("src/Studio/runtime/ScriptApi.java").split(/\r?\n/);
// 找 mine 命名空间构建（含 "state" 和 "reset" 两个 method）
let s0 = -1;
for (let k = 0; k < A.length - 3; k++) {
  if (/"state"/.test(A[k]) && /"reset"/.test(A.slice(k, k + 25).join("\n"))) { s0 = k; break; }
}
console.log("\n=== ScriptApi mine ns @" + (s0+1) + " ===");
const o2 = [];
A.forEach((l, k) => { if (k >= s0 - 12 && k < s0 + 78 && !skip(l.trim())) o2.push((k+1)+"| "+l.slice(0,172)); });
console.log(o2.join("\n"));
