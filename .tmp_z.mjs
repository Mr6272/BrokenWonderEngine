import { readFileSync } from "node:fs";
const f = readFileSync(".tmp_final.txt", "utf8");
console.log(f.slice(0, 2600));
