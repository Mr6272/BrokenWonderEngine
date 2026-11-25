import { readFileSync } from "node:fs";
const R = readFileSync("web/src/webplayer/renderer.ts", "utf8");
console.log(R);
