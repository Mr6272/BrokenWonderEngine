import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync("web/.build/packages/web_test_1/out/Build/scene_0.json", "utf8"));
console.log("keys:", Object.keys(s));
console.log("objects:", s.objects.length);
for (const o of s.objects) {
  const line = { id: o.id, type: o.type, assetId: o.assetId, x: o.x, y: o.y, w: o.w, h: o.h, scaleX: o.scaleX, scaleY: o.scaleY, layer: o.layer, z: o.z };
  const extra = Object.keys(o).filter(k => !(k in line) && k !== "props");
  console.log(JSON.stringify(line) + (extra.length ? "  extra:" + extra.join(",") : ""));
  if (o.props) console.log("    props:", JSON.stringify(o.props).slice(0, 300));
  if (o.modules) console.log("    modules:", JSON.stringify(o.modules).slice(0, 300));
}
