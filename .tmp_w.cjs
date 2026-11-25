const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
fs.writeFileSync(".tmp_pwseg.txt", L.slice(2004,2090).map((l,i)=>(2005+i)+"| "+A(l)).join("\n"),"utf8");
