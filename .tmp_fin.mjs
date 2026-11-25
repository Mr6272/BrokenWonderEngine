import { readFileSync, writeFileSync } from "node:fs";
const out = [];
const sc = JSON.parse(readFileSync("web/.build/packages/web_test_1/out/Build/scene_0.json", "utf8"));
out.push("=== \u68cb\u76d8\u5bf9\u8c61 ===");
for (const o of sc.objects) {
  if (/棋盘|Minesweeper/i.test(JSON.stringify(o))) out.push(JSON.stringify(o, null, 1).slice(0, 1800));
}
out.push("\n=== scene \u9876\u5c42 keys ===");
out.push(Object.keys(sc).join(", ") + "  size=" + sc.width + "x" + sc.height);

const P = readFileSync("web/src/webplayer/player.ts", "utf8").split(/\r?\n/);
out.push("\n=== player.ts \u8f93\u5165/\u4e3b\u5faa\u73af ===");
P.forEach((l, i) => { if (/addEventListener|pointer|mouse|keydown|input\.|requestAnimationFrame|onSceneStart|onUpdate|drawQueue|render\(|scripts/.test(l)) out.push((i+1)+"| "+l.trim().slice(0,140)); });
writeFileSync(".tmp_final.txt", out.join("\n"), "utf8");
console.log(out.join("\n"));
