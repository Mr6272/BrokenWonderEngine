const fs=require("fs");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(B.slice(648,802).map((l,i)=>(649+i)+"| "+l).join("\n"));
