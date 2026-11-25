const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
let s=-1,e=-1;
L.forEach((l,i)=>{ if(/^export async function packageWeb/.test(l)) s=i; });
L.forEach((l,i)=>{ if(s>=0 && i>s && /^export /.test(l)) { if(e<0) e=i; } });
console.log("start line",s+1,"end line",e+1,"total",L.length);
console.log(L.slice(s, Math.min(e, s+120)).map((l,i)=>(s+1+i)+"| "+l).join("\n"));
