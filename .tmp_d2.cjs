const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
fs.writeFileSync(".tmp_pk8.txt", L.slice(0,80).map((l,i)=>(1+i)+"| "+l).join("\n"),"utf8");
fs.writeFileSync(".tmp_pk9.txt", L.slice(300,345).map((l,i)=>(301+i)+"| "+l).join("\n"),"utf8");
