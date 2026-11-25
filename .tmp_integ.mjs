import { readFileSync } from "node:fs";
const R = readFileSync("web/src/webplayer/renderer.ts", "utf8").split(/\r?\n/);
console.log("=== renderer \u65b9\u6cd5\u7b7e\u540d ===");
R.forEach((l,i)=>{ if(/^\s{2}(async\s+)?[a-zA-Z]\w*\s*\(|^export |texs\.|setAssetTexture|loadTexture/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,120)); });
const P = readFileSync("web/src/webplayer/player.ts", "utf8").split(/\r?\n/);
console.log("\n=== player \u6307\u9488/\u4e16\u754c\u5750\u6807 ===");
P.forEach((l,i)=>{ if(/pointer|onDown|onUp|onMove|mousedown|mouseup|toWorld|screenToWorld|worldX|worldY|buildApi|createApi|shims/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,130)); });
