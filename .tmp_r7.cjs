const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
L.forEach((l,i)=>{ if(/package-bwe|packageBwe|packageAndroid|packageWeb|binary:|download/.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,160)); });
