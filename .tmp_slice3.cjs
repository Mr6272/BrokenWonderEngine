const fs=require("fs");
const lines=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
let start=0;
lines.forEach((l,i)=>{ if(/async function runJob/.test(l)) start=i; });
console.log(lines.slice(start-4,start+80).map((l,i)=>(start-3+i)+"| "+l).join("\n"));
