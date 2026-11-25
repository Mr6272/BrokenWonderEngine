const fs=require("fs");
const lines=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(lines.slice(834,935).map((l,i)=>(835+i)+"| "+l).join("\n"));
