const fs=require("fs");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(B.slice(619,800).map((l,i)=>(620+i)+"| "+l).join("\n"));
