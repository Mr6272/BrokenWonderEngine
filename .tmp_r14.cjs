const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
function show(tag,f,a,b){const L=fs.readFileSync(f,"utf8").split(/\r?\n/);console.log("\n##### "+tag+" | "+a+"-"+b);for(let i=a-1;i<Math.min(b,L.length);i++)console.log((i+1)+"| "+ascii(L[i]));}
show("packageWeb tail","web/tools/package-bwe.mjs",2086,2173);
show("api-core imports","web/tools/api-core.mjs",1,40);
show("openBwePackager sig","web/src/app/packageBwe.ts",300,340);
