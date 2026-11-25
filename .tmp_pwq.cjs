const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
const s=L.findIndex(l=>/function packageWeb/.test(l));
let e=L.length; for(let i=s+1;i<L.length;i++){ if(/^export /.test(L[i])){e=i;break;} }
console.log("range",s+1,e);
for(let i=s;i<e;i++){ if(/zip|sizeBytes|return|player|index\.html|outDir|name:/.test(L[i])) console.log((i+1)+"| "+ascii(L[i]).trim().slice(0,120)); }
