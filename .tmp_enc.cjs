const fs=require("fs");
const buf=fs.readFileSync("web/src/app/packageBwe.ts");
// detect
const asUtf8=buf.toString("utf8");
const repl=(asUtf8.match(/\uFFFD/g)||[]).length;
console.log("bytes",buf.length,"replacement chars when read as utf8:",repl);
try{
  const dec=new TextDecoder("gbk");
  const s=dec.decode(buf);
  const L=s.split(/\r?\n/);
  console.log("GBK decoded line 106:", L[105].trim());
  console.log("GBK decoded line 384:", L[383].trim().slice(0,80));
}catch(e){console.log("gbk decode fail",e.message);}
