const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log(L.slice(28,60).map((l,i)=>(29+i)+"| "+l).join("\n"));
console.log("##### 100-130 #####");
console.log(L.slice(99,130).map((l,i)=>(100+i)+"| "+l).join("\n"));
console.log("##### 340-400 #####");
console.log(L.slice(339,400).map((l,i)=>(340+i)+"| "+l).join("\n"));
