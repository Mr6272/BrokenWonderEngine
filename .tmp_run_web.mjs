import { packageWeb } from "./web/tools/package-bwe.mjs";
import { readFile, readdir } from "node:fs/promises";

const files = await readdir("web/examples");
const target = files.find((f) => f.startsWith("\u626b\u96f7") && f.endsWith(".bwproj") && !f.includes("\u793a\u4f8b"));
console.log("目标工程:", target);
const proj = JSON.parse(await readFile("web/examples/" + target, "utf8"));
const stats = await packageWeb(proj, null, { name: "扫雷-Web", version: "1.0.0", jobId: "web_test_1" }, (m) => console.log(m));
console.log("\n=== RESULT ===");
console.log(JSON.stringify({ outDir: stats.outDir, playerBytes: stats.playerBytes, buildFiles: stats.buildFiles, warnings: stats.warnings }, null, 1));
