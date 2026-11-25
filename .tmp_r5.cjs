const fs=require("fs");
function show(f,a,b){const L=fs.readFileSync(f,"utf8").split(/\r?\n/);console.log("### "+f+" "+a+"-"+b);console.log(L.slice(a-1,b).map((l,i)=>(a+i)+"| "+l).join("\n"));}
show("web/tools/api-core.mjs",1,45);
show("web/tools/api-core.mjs",855,900);
