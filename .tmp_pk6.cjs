const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(L.slice(560,700).map((l,i)=>(561+i)+"| "+l).join("\n"));
