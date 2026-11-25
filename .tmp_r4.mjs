import { readFileSync } from "node:fs";
const S = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
console.log("=== 1-96 ===");
console.log(S.slice(0, 96).map((l,k)=>(1+k)+"| "+l.slice(0,160)).join("\n"));
const sc = JSON.parse(readFileSync("web/.build/packages/web_test_1/out/Build/scene_0.json", "utf8"));
console.log("\n=== scene objects ===");
for (const o of sc.objects) console.log(JSON.stringify({ id: o.id, type: o.type, assetId: o.assetId, x: o.x, y: o.y, w: o.w, h: o.h, modules: o.modules, props: o.props }).slice(0, 700));
