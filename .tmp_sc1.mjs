import { readFileSync } from "node:fs";
const sc = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
const show = (from, to) => console.log(sc.slice(from, to).map((l, k) => (from + 1 + k) + "| " + l.slice(0, 170)).join("\n"));
console.log("=== onSceneStart 尾部 95-160 ===");
show(94, 160);
