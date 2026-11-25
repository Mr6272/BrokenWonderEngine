const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
function show(tag,f,a,b){const L=fs.readFileSync(f,"utf8").split(/\r?\n/);console.log("\n##### "+tag+" | "+a+"-"+b);for(let i=a-1;i<Math.min(b,L.length);i++)console.log((i+1)+"| "+ascii(L[i]));}
show("editor 740-770","web/src/app/editor.ts",740,772);
show("editor 1628-1645","web/src/app/editor.ts",1628,1645);
show("editor 2306-2340","web/src/app/editor.ts",2306,2340);
show("editor openBwePackager calls","web/src/app/editor.ts",285,305);
