const fs=require("fs");
const s=fs.readFileSync("web/tools/package-bwe.mjs","utf8");
const i=s.indexOf("export async function packageWeb");
const tail=s.slice(i);
const r=tail.lastIndexOf("return {");
console.log("total tail len",tail.length,"return idx",r);
console.log(tail.slice(r-1500));
