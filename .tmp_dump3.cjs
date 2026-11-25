const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
function show(tag,f,a,b){const L=fs.readFileSync(f,"utf8").split(/\r?\n/);console.log("\n##### "+tag+" "+f+" "+a+"-"+b);for(let i=a-1;i<Math.min(b,L.length);i++)console.log((i+1)+"| "+ascii(L[i]));}
show("imports","web/tools/api-core.mjs",1,34);
show("run helper","web/tools/package-bwe.mjs",60,105);
show("editor menu","web/src/app/editor.ts",744,772);
show("editor cmd","web/src/app/editor.ts",1626,1652);
show("editor exportWeb","web/src/app/editor.ts",2306,2336);
