import { readFileSync } from "node:fs";
const sc = JSON.parse(readFileSync("web/.build/packages/web_test_1/out/Build/scene_0.json", "utf8"));
console.log("objects:", sc.objects.length, "size:", sc.width + "x" + sc.height);
sc.objects.forEach((o, i) => {
  console.log("--- [" + i + "] ---");
  console.log(JSON.stringify(o).slice(0, 1200));
});
