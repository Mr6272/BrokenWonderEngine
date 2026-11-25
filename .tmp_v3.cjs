const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
process.stdout.write(fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/).slice(700,802).map((l,i)=>(701+i)+"| "+ascii(l)).join("\n"));
