const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
function grep(f,re,cap=150){const r=new RegExp(re);console.log("### "+f);fs.readFileSync(f,"utf8").split(/\r?\n/).forEach((l,i)=>{if(r.test(l))console.log((i+1)+"| "+ascii(l).trim().slice(0,cap));});}
grep("web/src/app/editor.ts","exportWeb|exportAndroid|exportWindows|packageBwe|exportDesktop");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log("### packageBwe.ts exports");
B.forEach((l,i)=>{ if(/^export (async )?(function|const|interface|type|class)/.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,160)); });
