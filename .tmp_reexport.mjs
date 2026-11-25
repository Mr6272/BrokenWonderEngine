import { readFileSync } from "node:fs";
import { packageWeb } from "./web/tools/package-bwe.mjs";
const proj = JSON.parse(readFileSync("web/examples/\u626b\u96f7.bwproj", "utf8"));
const r = await packageWeb(proj, null, {
  outDir: "D:\\githubdesktop\\BrokenWonderEngine\\web\\.build\\packages\\web_test_1",
  name: "BWE \u626b\u96f7",
  version: "1.0.0",
  jobId: "web_test_1",
}, (s) => console.log(s));
console.log(JSON.stringify(r, null, 2));
