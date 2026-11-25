const fs=require("fs");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(B.slice(339,430).map((l,i)=>(340+i)+"| "+l).join("\n"));
