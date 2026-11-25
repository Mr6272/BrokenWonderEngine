import { readFileSync } from "node:fs";
const A = readFileSync("src/Studio/runtime/ScriptApi.java", "utf8").split(/\r?\n/);
const i = A.findIndex((l) => /case "mine"|buildMine|mineSet/.test(l));
// 打印 mine 命名空间构建附近
for (let k = 1500; k < 1600 && k < A.length; k++) {
  if (/mine|reset|"set"|"state"/.test(A[k])) console.log((k+1)+"| "+A[k].slice(0,175));
}
console.log("--- 1495-1560 ---");
console.log(A.slice(1494, 1560).map((l,k)=>(1495+k)+"| "+l.slice(0,175)).join("\n"));
