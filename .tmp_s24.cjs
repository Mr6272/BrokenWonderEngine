const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/^export async function|^async function zipApp|^function zipApp|^async function run\(|^function run\(/.test(l)) console.log((i+1)+"| "+l); });
