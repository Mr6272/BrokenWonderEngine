const fs=require("fs");
const lines=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(lines.slice(914,955).map((l,i)=>(915+i)+"| "+l).join("\n"));
