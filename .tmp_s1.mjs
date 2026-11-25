import { readFileSync } from "node:fs";
const L = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
const show = (a, b) => console.log(L.slice(a - 1, b).map((l, k) => (a + k) + "| " + l.slice(0, 175)).join("\n"));
console.log("=== 95-160 (onSceneStart + mine.state/set) ===");
show(95, 160);
