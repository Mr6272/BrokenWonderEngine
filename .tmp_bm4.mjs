import { readFileSync } from "node:fs";
const buf = readFileSync("src/Studio/runtime/ScriptApi.java");
let s; try { s = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { s = new TextDecoder("gbk").decode(buf); }
const L = s.split(/\r?\n/);
const i = L.findIndex((l) => /private void buildMine\(\)/.test(l));
console.log("buildMine at " + (i + 1));
console.log(L.slice(i, i + 115).map((l, k) => (i + 1 + k) + "| " + l.replace(/\s+$/, "").slice(0, 172)).join("\n"));
