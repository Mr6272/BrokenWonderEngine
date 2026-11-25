import { readFileSync } from "node:fs";
const S = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
const want = /bwe\.mine|bwe\.input|bwe\.textinput|\.props|bwe\.audio|bwe\.draw|bwe\.grid/;
S.forEach((l, i) => { if (want.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
