/**
 * 手工精确核验（不依赖 diff-apidocs.mjs 那套易错的正则）。
 *
 * 为什么单独写：`diff-apidocs.mjs` 的签名归一化我改了 8 次，数字在
 * 17/0/35/276/86/79/70/31/45 之间反复跳。每次都是"我改的是对的"，
 * 但每次结果都不同 —— 这本身就说明**用正则做语法归一化不可靠**。
 * 要给出可信的基线，必须换一种独立方法交叉验证。
 *
 * 这里的做法：直接按 apiDocs 的**字面签名**取出参数个数（只数顶层逗号），
 * 与 d.ts 里同名声明的参数个数比较。**只比个数**，不比名字 ——
 * "名字不同但个数相同"传递不出错，而"个数不同"用户一定调错。
 */
import { readFileSync } from "node:fs";

const docsSrc = readFileSync(new URL("../../src/data/apiDocs.ts", import.meta.url), "utf8");
const dtsSrc = readFileSync(new URL("../../src/js/bwe.d.ts", import.meta.url), "utf8");

/** 按顶层逗号切分（括号/花括号/尖括号/方括号都计入深度）。 */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("({[<".includes(ch)) depth++;
    else if (")}]>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** 从一段文本里取出第一对圆括号内的内容（深度感知）。 */
function firstParens(s) {
  const i = s.indexOf("(");
  if (i < 0) return "";
  let depth = 0;
  let inside = "";
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if ("({[<".includes(ch)) depth++;
    else if (")}]>".includes(ch)) {
      depth--;
      if (depth === 0 && ch === ")") return s.slice(i + 1, k);
    }
  }
  return "";
}

/** 参数个数（只数顶层逗号）。空参数 = 0。 */
function argCount(sig) {
  const inside = firstParens(sig);
  if (!inside.trim()) return 0;
  return splitTop(inside).length;
}

// ---- 取 apiDocs 的所有 d(...) 条目 ----
const docs = [];
const re = /d\("([^"]+)",\s*"((?:[^"\\]|\\.)*)"/g;
let m;
while ((m = re.exec(docsSrc))) docs.push({ name: m[1], signature: m[2].replace(/\\"/g, '"') });
console.log(`[exact] apiDocs 条目 ${docs.length}`);

// ---- 取 d.ts 的成员声明 ----
// 用 TS 语言服务更准，但这里要的是**独立方法**，所以退一步：
// 按 "成员名(" 抓声明（会抓到注释里的例子，所以再过滤掉以 // / * 开头的行）
const dtsDecls = new Map();
for (const line of dtsSrc.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
  const dm = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\([^;]*\))?\s*[?:]?\s*([A-Za-z_$][\w$]*|"|')?/.exec(t);
  if (dm && dm[2]) {
    const name = dm[1];
    if (!dtsDecls.has(name)) dtsDecls.set(name, argCount(t));
  }
}
console.log(`[exact] d.ts 抓到的成员声明 ${dtsDecls.size} 条`);

// ---- 比对 ----
let same = 0;
let diff = [];
let noDecl = [];
for (const d of docs) {
  if (!d.name.startsWith("bwe.")) continue;
  const member = d.name.split(".").pop();
  const docArgs = argCount(d.signature);
  if (!dtsDecls.has(member)) {
    noDecl.push(d);
    continue;
  }
  const dtsArgs = dtsDecls.get(member);
  if (docArgs === dtsArgs) same++;
  else diff.push({ name: d.name, docArgs, dtsArgs, signature: d.signature });
}

console.log("");
console.log("========== 精确核验（只比参数个数）==========");
console.log(`[exact] 参数个数一致: ${same} 条`);
console.log(`[exact] 参数个数不同: ${diff.length} 条`);
for (const d of diff.slice(0, 20)) {
  console.log(`[exact]    ${d.name}：apiDocs ${d.docArgs} 个 / d.ts ${d.dtsArgs} 个  「${d.signature.slice(0, 60)}」`);
}
console.log(`[exact] d.ts 里找不到同名声明: ${noDecl.length} 条（这些需要语言服务才能确认，见 diff-apidocs.mjs）`);
