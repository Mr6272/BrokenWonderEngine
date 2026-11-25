const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
function dump(f,a,b){const L=fs.readFileSync(f,"utf8").split(/\r?\n/);console.log("\n##### "+f+" "+a+"-"+b);for(let i=a-1;i<Math.min(b,L.length);i++)console.log((i+1)+"| "+A(L[i]));}
dump("web/src/app/packageBwe.ts",1,36);
dump("web/src/app/packageBwe.ts",175,300);
