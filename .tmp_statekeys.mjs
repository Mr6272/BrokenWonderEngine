import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const skip = (t) => /^\*|^\/\*\*|^\/\//.test(t);
const files = ["src/Studio/runtime/ScriptApi.java","src/Studio/runtime/ScriptMine.java","src/Studio/runtime/ScriptModules.java"];
for (const f of files) {
  let s; try { s = rd(f); } catch { continue; }
  if (!/mine/i.test(s)) continue;
  const L = s.split(/\r?\n/);
  const idx = [];
  L.forEach((l,i)=>{ if(/mine\.(state|set|reset)|"flags"|"started"|"elapsed"|"mineCount"|"rows"|"cols"|"cell"/.test(l)) idx.push(i); });
  if (!idx.length) continue;
  console.log("### " + f);
  const lo = Math.max(0, idx[0]-6), hi = Math.min(L.length, idx[idx.length-1]+8);
  console.log(L.slice(lo,hi).filter(l=>!skip(l.trim())).map((l,k)=>"  "+l.slice(0,168)).join("\n"));
}
