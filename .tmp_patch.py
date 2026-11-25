import io
p = "web/tools/package-bwe.mjs"
s = io.open(p, encoding="utf-8").read()

old_imp = 'import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";'
new_imp = 'import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";'
if old_imp in s:
    s = s.replace(old_imp, new_imp, 1)
    print("cp import: added")
else:
    print("cp import: anchor MISSING")

add = io.open(".tmp_webpkg_add.js", encoding="utf-8").read().replace("repoRoot", "projectRoot")
anchor = "export { safeSegment, safeVersion, extensionForAsset, writeBuild, decideOrientation };"
if anchor in s:
    s = s.replace(anchor, add + "\n" + anchor, 1)
    print("packageWeb: inserted")
else:
    print("packageWeb: anchor MISSING")

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("repoRoot remaining:", s.count("repoRoot"))
print("has packageWeb:", "export async function packageWeb" in s)
