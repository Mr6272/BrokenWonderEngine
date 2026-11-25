import { readFileSync, writeFileSync } from "node:fs";
const p = "web/tools/verify-web-player.mjs";
let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// 1) 就绪判定：等 __bwe_player 真的出现（而不是画布存在）
s = s.replace(
  /  const r = await ev\("document\.readyState === 'complete' && !!document\.getElementById\('bwe-canvas'\)"\);/,
  '  const r = await ev("!!window.__bwe_player");',
);

// 2) 统计要从 player.stats 取（__bwe_stats 是同引用，但直接取更稳）
s = s.replace(
  /const stats = await ev\("JSON\.stringify\(window\.__bwe_stats\)"\);/,
  'const stats = await ev("JSON.stringify(window.__bwe_player ? window.__bwe_player.stats : null)");',
);

writeFileSync(p, s, "utf8");
console.log("patched readiness:", s.includes("!!window.__bwe_player"));
