import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/main.ts";
let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const before = s;
// 让验证脚本能拿到播放器：load 成功后挂两个诊断全局
if (!s.includes("__bwe_player_ready")) {
  s = s.replace(
    /(window as unknown as Record<string, unknown>)\.__bwe_player = /,
    "(window as unknown as Record<string, unknown>).__bwe_player_ready = true;\n  (window as unknown as Record<string, unknown>).__bwe_player = ",
  );
}
if (s === before) { console.log("no change (already has flag?)"); }
writeFileSync(p, s, "utf8");
console.log("main ok:", s.includes("__bwe_player_ready"));
