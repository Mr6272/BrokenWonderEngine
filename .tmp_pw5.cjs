const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
const s=L.findIndex(l=>/^export async function packageWeb/.test(l));
const out=[];
for(let i=s;i<L.length && i<s+200;i++){
  const l=L[i];
  if(/^\s*return\b|zipPath|zipName|sizeBytes|outDir:|indexPath|player\.js|index\.html|writeBuild|const .*Dir =/.test(l)) out.push((i+1)+"| "+A(l).trim().slice(0,120));
}
process.stdout.write(out.join("\n"));
