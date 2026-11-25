const fs=require("fs");
const f=process.argv[2];
const marker=process.argv[3];
const before=Number(process.argv[4]||0);
const len=Number(process.argv[5]||2500);
const s=fs.readFileSync(f,"utf8");
const i=s.indexOf(marker);
if(i<0){console.log("MARKER NOT FOUND: "+marker);process.exit(1);}
console.log(s.slice(Math.max(0,i-before), i-before+len));
