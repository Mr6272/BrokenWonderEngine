const fs=require("fs");
const lines=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
lines.forEach((l,i)=>{ if(/^import|require\(|packageBwe|packageAndroid|packageWeb/.test(l)) console.log((i+1)+"| "+l.trim()); });
