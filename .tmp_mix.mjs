import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const L = rd("src/Studio/runtime/Minesweeper.java").split(/\r?\n/);
L.forEach((l,i)=>{ if(/^\s*(void|boolean|int|String|float|double)\s+\w+\(/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,110)); });
