const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
const s=L.findIndex(l=>/^export async function packageWeb/.test(l));
let e=L.length; for(let i=s+1;i<L.length;i++){ if(/^export /.test(L[i])){e=i;break;} }
for(let i=s;i<e;i++) console.log((i+1)+"| "+A(L[i]));
