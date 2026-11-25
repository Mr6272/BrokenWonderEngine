const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
fs.writeFileSync(".tmp_view.txt", fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/).slice(305,470).map((l,i)=>(306+i)+"| "+ascii(l)).join("\n"), "utf8");
console.log("ok");
