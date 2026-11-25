import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const out = [];
const A = rd("src/Studio/runtime/ScriptApi.java").split(/\r?\n/);
// 找 mine 对象的构造：连续出现 "state"/"set"/"reset" 方法定义
let start = -1;
for (let i = 0; i < A.length; i++) {
  if (/mineState\s*\(|stateJson|buildMineState/.test(A[i])) { start = i; break; }
}
out.push("start=" + (start+1));
if (start >= 0) {
  for (let k = start; k < Math.min(A.length, start + 60); k++) {
    const t = A[k].trim();
    if (/^\*|^\/\*\*|^\/\//.test(t) || !t) continue;
    out.push((k+1) + "| " + A[k].replace(/\s+$/,"").slice(0,175));
  }
}
out.push("\n=== \u811a\u672c\u8bfb\u53d6\u7684 state \u5b57\u6bb5 ===");
const S = rd("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js");
const fs = new Set();
for (const m of S.matchAll(/\b(?:st|s0|S)\.([A-Za-z_]\w*)/g)) fs.add(m[1]);
out.push([...fs].sort().join(" "));
console.log(out.join("\n"));
