import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git|\.tmp/.test(e.name)) walk(p, out); }
    else if (e.name.endsWith(".java")) out.push(p);
  }
  return out;
}
const files = walk("src");
for (const f of files) {
  const s = readFileSync(f, "utf8");
  if (!/hitMine/.test(s)) continue;
  const L = s.split(/\r?\n/);
  console.log("### " + f);
  L.forEach((l, i) => { if (/hitMine|modeIndex|\"flags\"|\"started\"|\"won\"|\"over\"|\"elapsed\"/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
}
