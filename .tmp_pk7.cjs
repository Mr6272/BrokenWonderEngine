const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(L.slice(700,802).map((l,i)=>(701+i)+"| "+l).join("\n"));
