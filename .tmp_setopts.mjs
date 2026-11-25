import { readFileSync } from "node:fs";
const buf = readFileSync("src/Studio/runtime/ScriptApi.java");
let s; try { s = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { s = new TextDecoder("gbk").decode(buf); }
const L = s.split(/\r?\n/);
const i = L.findIndex((l) => /"mine"/.test(l));
console.log("mine ns at " + (i + 1));
console.log(L.slice(i - 30, i + 60).map((l, k) => (i - 29 + k) + "| " + l.replace(/\s+$/, "").slice(0, 170)).join("\n"));
