const fs=require("fs");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(B.slice(429,560).map((l,i)=>(430+i)+"| "+l).join("\n"));
