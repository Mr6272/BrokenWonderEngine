const fs=require("fs");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(B.slice(305,470).map((l,i)=>(306+i)+"| "+l).join("\n"));
