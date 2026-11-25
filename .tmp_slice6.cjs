const fs=require("fs");
const lines=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(lines.slice(565,626).map((l,i)=>(566+i)+"| "+l).join("\n"));
console.log("=====");
console.log(lines.slice(840,915).map((l,i)=>(841+i)+"| "+l).join("\n"));
