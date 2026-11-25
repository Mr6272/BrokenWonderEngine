const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
let s=-1;
L.forEach((l,i)=>{ if(/async function runJob/.test(l)) s=i; });
console.log(L.slice(s,s+90).map((l,i)=>(s+1+i)+"| "+l).join("\n"));
