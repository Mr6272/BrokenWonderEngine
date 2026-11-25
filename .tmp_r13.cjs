const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
function show(tag,f,a,b){const L=fs.readFileSync(f,"utf8").split(/\r?\n/);console.log("\n##### "+tag+" | "+a+"-"+b);for(let i=a-1;i<Math.min(b,L.length);i++)console.log((i+1)+"| "+ascii(L[i]));}
show("zipApp+run","web/tools/package-bwe.mjs",1380,1432);
show("exports tail","web/tools/package-bwe.mjs",2170,2180);
