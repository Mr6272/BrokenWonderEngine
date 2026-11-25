const fs=require("fs");
const [,, f, a, b] = process.argv;
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g, ".");
const L=fs.readFileSync(f,"utf8").split(/\r?\n/);
const s=Number(a||1), e=Number(b||L.length);
for(let i=s-1;i<Math.min(e,L.length);i++) console.log((i+1)+"| "+ascii(L[i]));
