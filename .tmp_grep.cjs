const fs=require("fs");
const [,,f,pat]=process.argv;
const re=new RegExp(pat,"i");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
fs.readFileSync(f,"utf8").split(/\r?\n/).forEach((l,i)=>{ if(re.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,150)); });
