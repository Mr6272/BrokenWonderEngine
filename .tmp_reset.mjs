import { readFileSync } from "node:fs";
const A = readFileSync("src/Studio/runtime/ScriptApi.java", "utf8").split(/\r?\n/);
const i = A.findIndex((l) => /Shortcuts\.put\(bwe, "mine"/.test(l)) >= 0 ? A.findIndex((l) => /Shortcuts\.put\(bwe, "mine"/.test(l)) : A.findIndex((l) => /"mine", o/.test(l));
// 直接找 mine 命名空间 o 的构建起点
const j = A.findIndex((l) => /ScriptJs\.obj\(\)/.test(l) && /mine/i.test(A.slice(Math.max(0,0), 0).join("")) );
// 用更可靠的锚点：搜索 "reset" 在同一段
for (let k = 1400; k < 1500; k++) if (A[k]) console.log((k+1)+"| "+A[k].slice(0,175));
