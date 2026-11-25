import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const G = rd("src/Studio/runtime/GridPainter.java").split(/\r?\n/);
console.log("TOTAL " + G.length);
G.forEach((l,i)=>{ const t=l.trim(); if(/^\*|^\/\*\*|^\/\//.test(t)) return; if(/void |int |float |Color|drawDigit|texCoords|glBegin|number|asset/i.test(l)) console.log((i+1)+"| "+t.slice(0,140)); });
