const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
fs.writeFileSync(".tmp_out2.txt", L.slice(2095,2175).map((l,i)=>(2096+i)+"| "+l).join("\n"),"utf8");
