const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
function show(tag,f,a,b){const L=fs.readFileSync(f,"utf8").split(/\r?\n/);console.log("\n##### "+tag+" | "+a+"-"+b);for(let i=a-1;i<Math.min(b,L.length);i++)console.log((i+1)+"| "+ascii(L[i]));}
show("status route","web/tools/api-core.mjs",800,866);
show("packager platform set","web/src/app/packageBwe.ts",640,700);
show("packager result box","web/src/app/packageBwe.ts",735,802);
