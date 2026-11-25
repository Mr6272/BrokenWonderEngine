const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
B.forEach((l,i)=>{ if(/start\(|plat\b|platform =|let platform|const plat/.test(l)) console.log((i+1)+"| "+A(l).trim().slice(0,140)); });
