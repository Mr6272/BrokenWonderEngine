const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/download|packageBwe|packageAndroid|import\b/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,190)); });
