const fs=require("fs");
const s=fs.readFileSync("web/tools/package-bwe.mjs","utf8");
const i=s.indexOf("export async function packageWeb");
const seg=s.slice(i, i+9000);
const out=seg.split(/\r?\n/).filter(l=>/return|zip|sizeBytes|outDir|player\.js|index\.html|Build\//.test(l)).map(l=>l.trim().slice(0,120));
console.log(out.join("\n"));
