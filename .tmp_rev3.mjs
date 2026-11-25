import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const L = rd("src/Studio/runtime/Minesweeper.java").split(/\r?\n/);
const out = [];
const i = L.findIndex((l) => /void reveal\s*\(int idx\)/.test(l));
out.push("reveal at " + (i+1));
for (let k = i; k < i + 45; k++) { const t = L[k].trim(); if (/^\*|^\/\*\*|^\/\//.test(t)) continue; out.push((k+1)+"| "+L[k].replace(/\s+$/,"")); }
const j = L.findIndex((l) => /void checkWin\s*\(\)/.test(l));
out.push("\ncheckWin at " + (j+1));
for (let k = j; k < j + 30; k++) { const t = L[k].trim(); if (/^\*|^\/\*\*|^\/\//.test(t)) continue; out.push((k+1)+"| "+L[k].replace(/\s+$/,"")); }
const c = L.findIndex((l) => /boolean chordStandard\s*\(/.test(l));
out.push("\nchordStandard at " + (c+1));
for (let k = c; k < c + 40; k++) { const t = L[k].trim(); if (/^\*|^\/\*\*|^\/\//.test(t)) continue; out.push((k+1)+"| "+L[k].replace(/\s+$/,"")); }
console.log(out.join("\n"));
