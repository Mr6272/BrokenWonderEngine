const fs=require("fs");
const lines=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(lines.slice(596,700).map((l,i)=>(597+i)+"| "+l).join("\n"));
