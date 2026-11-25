import { readFileSync } from "node:fs";
const A = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
A.forEach((l, i) => { if (/textinput|Entity|props|onSubmit|audioObj|put\(/.test(l)) console.log((i+1)+"| "+l.slice(0,140)); });
