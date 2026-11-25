const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
fs.writeFileSync(".tmp_pa.txt", L.slice(104,140).map((l,i)=>(105+i)+"| "+l).join("\n"),"utf8");
fs.writeFileSync(".tmp_pb.txt", L.slice(339,400).map((l,i)=>(340+i)+"| "+l).join("\n"),"utf8");
fs.writeFileSync(".tmp_pc.txt", L.slice(650,802).map((l,i)=>(651+i)+"| "+l).join("\n"),"utf8");
