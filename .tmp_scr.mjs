import { readFileSync } from "node:fs";
const L = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
console.log("total lines:", L.length);
const want = /pushBoard|bwe\.draw\.|bwe\.input\.|onUpdate|onSceneStart|function \w+/;
L.forEach((l, i) => { if (want.test(l)) console.log((i + 1) + "| " + l.trim().slice(0, 150)); });
