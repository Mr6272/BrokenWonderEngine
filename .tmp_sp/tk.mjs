const { scriptParamKeys } = await import("../web/tools/package-bwe.mjs");
for (const t of ['bwe.params({ speed: 100, "中文键": "x", alive: true })',
                 '// bwe.params({a:1})',
                 'bwe.params({ a: {b:1} })',
                 'bwe.params({ a: 1, b: "x}y" })']) {
  const r = scriptParamKeys(t);
  console.log(JSON.stringify(t), "->", r ? [...r] : r);
}
