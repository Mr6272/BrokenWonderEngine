const fs=require("fs"),path=require("path");
function walk(d,out=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(/node_modules|\.build|\.git/.test(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else if(/\.(mjs|cjs|js|ts)$/.test(e.name))out.push(p);}return out;}
for(const f of walk("web/tools").concat(walk("desktop/lib"))){
  const L=fs.readFileSync(f,"utf8").split(/\r?\n/);
  L.forEach((l,i)=>{ if(/async function runJob|function jobPublic|packageAndroid\(|packageBwe\(|packageWeb\(/.test(l)) console.log(f+":"+(i+1)+"| "+l.trim().slice(0,140)); });
}
