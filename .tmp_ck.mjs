import { readFileSync } from "node:fs";
S: {
}
const S = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const L = S.split(/\r?\n/);
console.log("=== \u70b9\u51fb\u76f8\u5173\u884c ===");
L.forEach((l,i)=>{ if(/clicked|clickedAt|bwe\.input|pointer|mouse|<|hitCell|cellAt|reveal|flagAt|rightClick/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,145)); });
