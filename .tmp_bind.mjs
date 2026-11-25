import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };

const sc = JSON.parse(readFileSync("web/.build/packages/web_test_1/out/Build/scene_0.json", "utf8"));
console.log("=== scene objects (" + sc.objects.length + ") ===");
for (const o of sc.objects) {
  console.log(JSON.stringify({ id: o.id, name: o.name, kind: o.kind, assetId: o.assetId, x: o.x, y: o.y, halfW: o.halfW, halfH: o.halfH, modules: o.modules }).slice(0, 500));
}
console.log("\n=== modules.ts \u91cc\u7684 mine ===");
const m = rd("web/src/data/modules.ts");
m.split(/\r?\n/).forEach((l, i) => { if (/mine|sweep/i.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });

console.log("\n=== TopDownRuntime click \u8def\u7531 ===");
const t = rd("src/Studio/runtime/TopDownRuntime.java");
t.split(/\r?\n/).forEach((l, i) => { if (/minesweeper\.|minesweeper\s*==|new Minesweeper|\.click\(/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
