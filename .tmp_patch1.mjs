import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/player.ts";
let s = readFileSync(p, "utf8");
s = s.replace(/\r\n/g, "\n"); // 统一成 LF 再打补丁，避免混行

const a1 = "  private baseUrl: string;\n";
if (!s.includes(a1)) { console.error("no a1"); process.exit(1); }
s = s.replace(a1, a1 + "  /** boot.json 里 scene/script 的 file 相对 Build/（Java 侧 new File(buildDir, path)），素材 path 相对产物根。 */\n  private buildUrl: string;\n");

const a2 = "    this.baseUrl = baseUrl;\n";
if (!s.includes(a2)) { console.error("no a2"); process.exit(1); }
s = s.replace(a2, a2 + "    this.buildUrl = new URL(\"Build/\", baseUrl).href;\n");

const n1 = s.replace("new URL(sceneMeta.file, this.baseUrl).href", "new URL(sceneMeta.file, this.buildUrl).href");
const n2 = n1.replace("new URL(s.file, this.baseUrl).href", "new URL(s.file, this.buildUrl).href");
if (n2 === s) { console.error("no url change"); process.exit(1); }
writeFileSync(p, n2, "utf8");
console.log("OK buildUrl refs:", (n2.match(/buildUrl/g) || []).length);
