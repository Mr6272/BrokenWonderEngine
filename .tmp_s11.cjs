const fs=require("fs");
const lines=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(lines.slice(625,760).map((l,i)=>(626+i)+"| "+l).join("\n"));
