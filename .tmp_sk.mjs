import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const A = rd("src/Studio/runtime/ScriptApi.java").split(/\r?\n/);
const hits = [];
A.forEach((l, i) => { if (/modeIndex|hitMine|"elapsed"|"won"|"over"|"started"|"mines"|"flags"|"rows"|"cols"/.test(l)) hits.push(i); });
console.log("hit lines:", hits.slice(0, 40).join(","));
const lo = Math.max(0, Math.min(...hits) - 4), hi = Math.min(A.length, Math.max(...hits) + 4);
console.log(A.slice(lo, hi).map((l,k)=>(lo+1+k)+"| "+l.replace(/\s+$/,"").slice(0,172)).join("\n"));
