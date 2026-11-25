import { readFileSync } from "node:fs";
const code = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const lines = code.split(/\r?\n/);
// 找顶层语句：非缩进、非注释、非 function/var 声明块内容
const top = [];
let depth = 0;
lines.forEach((l, i) => {
  const t = l.trim();
  if (!t || /^\/\//.test(t) || /^\*/.test(t) || /^\/\*/.test(t)) return;
  if (depth === 0 && !/^(function|var|const|let)\b/.test(t)) top.push((i + 1) + "| " + t.slice(0, 160));
  depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
});
console.log("=== \u9876\u5c42\u8bed\u53e5 (" + top.length + ") ===");
console.log(top.join("\n") || "(none)");
console.log("\n=== while / for(;;) \u68c0\u67e5 ===");
lines.forEach((l, i) => { if (/while\s*\(|for\s*\(\s*;/.test(l)) console.log((i + 1) + "| " + l.trim().slice(0, 140)); });
