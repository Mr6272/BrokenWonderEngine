#!/usr/bin/env node
/**
 * 手工打包 .vsix（零依赖，不装 vsce）。
 *
 * VSIX 本质就是一个 ZIP，结构：
 *   [Content_Types].xml
 *   extension.vsixmanifest
 *   extension/package.json
 *   extension/extension.js
 *   extension/lib/**
 *   extension/data/**
 *   extension/snippets/**
 *   extension/README.md
 *
 * 这里自己实现 ZIP（deflate 用 node 的 zlib.deflateRawSync），不引 npm 包：
 * vsix 必须能被 VS Code 的安装器解开，所以格式要严格 —— 本地文件头 + 中心目录 + EOCD，
 * 文件名用 UTF-8（置 general purpose bit 11），时间戳固定成 1980-01-01（可复现构建）。
 *
 * 用法：
 *   node tools/vscode-bwe/build-vsix.mjs            # 打包到 tools/vscode-bwe/dist/
 *   node tools/vscode-bwe/build-vsix.mjs --verify   # 打包 + 解包自检（默认就带自检）
 *   node tools/vscode-bwe/build-vsix.mjs --no-verify
 *
 * 退出码：0 = 打包并自检通过；1 = 打包 / 自检失败。
 */

import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = HERE;
const REPO_ROOT = resolve(HERE, "..", "..");
const DIST_DIR = join(EXT_ROOT, "dist");
const TMP_DIR = join(EXT_ROOT, ".tmp");

const args = process.argv.slice(2);
const NO_VERIFY = args.includes("--no-verify");

const pkg = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8"));

/** vsix 里要打进去的目录 / 文件（顺序固定，便于复现）。 */
const INCLUDE_DIRS = ["lib", "data", "snippets"];
const INCLUDE_FILES = ["extension.js", "README.md", "package.json"];
const EXCLUDE_PATTERNS = [/\.tmp[/\\]/, /[/\\]dist[/\\]/, /[/\\]test[/\\]/, /node_modules/, /\.map$/];

// ============================================================================
// ZIP 写入（最小实现：store / deflate，UTF-8 文件名）
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间：固定 1980-01-01 00:00:00（可复现构建，避免每次哈希不同）。 */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 年 1980 / 月 1 / 日 1

/**
 * 写一个 ZIP。
 * @param {{name:string, data:Buffer}[]} entries
 * @returns {Buffer}
 */
function writeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const stored = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    const localTotal = local.length + nameBuf.length + stored.length;
    localParts.push(local, nameBuf, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += localTotal;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/**
 * 读一个 ZIP（只支持本实现产出的那种：无 zip64、无加密、无 data descriptor）。
 * @returns {{name:string, data:Buffer}[]}
 */
function readZip(buf) {
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法 ZIP：找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error(`中心目录损坏 @${cdOffset}`);
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const rawSize = buf.readUInt32LE(cdOffset + 24);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString("utf8");

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData = buf.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(compData) : compData;
    if (data.length !== rawSize) throw new Error(`${name} 解压后长度不符（${data.length} != ${rawSize}）`);
    out.push({ name, data });
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ============================================================================
// 收集文件
// ============================================================================

function shouldExclude(p) {
  return EXCLUDE_PATTERNS.some((re) => re.test(p));
}

function collectFiles(dir, base, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const rel = relative(base, full).replace(/\\/g, "/");
    if (shouldExclude(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectFiles(full, base, out);
    else if (st.isFile()) out.push({ rel, full });
  }
}

function collectExtensionFiles() {
  const files = [];
  for (const f of INCLUDE_FILES) {
    const full = join(EXT_ROOT, f);
    if (!existsSync(full)) {
      if (f === "README.md") continue; // README 可选，但我们会写
      throw new Error(`缺少必需文件：${f}`);
    }
    files.push({ rel: f, full });
  }
  for (const d of INCLUDE_DIRS) {
    const full = join(EXT_ROOT, d);
    if (!existsSync(full)) throw new Error(`缺少必需目录：${d}/`);
    collectFiles(full, EXT_ROOT, files);
  }
  return files;
}

// ============================================================================
// vsix 清单
// ============================================================================

function contentTypesXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".vsix" ContentType="application/octet-stream" />
</Types>
`;
}

function manifestXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${escapeXml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description || "")}</Description>
    <Categories>${(pkg.categories || []).map(escapeXml).join(",")}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines && pkg.engines.vscode ? pkg.engines.vscode : "^1.75.0")}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="1.75.0" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================================
// 构建
// ============================================================================

function build() {
  mkdirSync(DIST_DIR, { recursive: true });
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });

  const files = collectExtensionFiles();
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml(), "utf8") },
    { name: "extension.vsixmanifest", data: Buffer.from(manifestXml(), "utf8") },
  ];
  for (const f of files) {
    entries.push({ name: `extension/${f.rel}`, data: readFileSync(f.full) });
  }

  const zip = writeZip(entries);
  const vsixPath = join(DIST_DIR, `${pkg.name}-${pkg.version}.vsix`);
  writeFileSync(vsixPath, zip);
  return { vsixPath, files, zip, entries };
}

/**
 * 解包自检：必需条目齐全、package.json 能 parse、[Content_Types].xml 与 vsixmanifest 结构基本合法、
 * 每个 JS 文件能过 `node --check`（用 vm/Function 构造做语法解析，避免起子进程）。
 */
function verify(vsixPath) {
  const problems = [];
  const notes = [];
  const buf = readFileSync(vsixPath);
  let entries;
  try {
    entries = readZip(buf);
  } catch (e) {
    return { ok: false, problems: [`无法解包：${e.message}`], notes: [], entries: [] };
  }
  const byName = new Map(entries.map((e) => [e.name, e]));

  const required = [
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/extension.js",
    "extension/lib/apiIndex.js",
    "extension/lib/analyzer.js",
    "extension/lib/serverCheck.js",
    "extension/data/bwe-api.json",
    "extension/data/bwe.d.ts",
    "extension/snippets/bwe.code-snippets",
    "extension/README.md",
  ];
  for (const name of required) {
    if (!byName.has(name)) problems.push(`缺少必需条目：${name}`);
  }
  if (!problems.length) notes.push(`必需条目齐全（${required.length} 项）`);

  // package.json 可 parse 且关键字段正确
  const pkgEntry = byName.get("extension/package.json");
  if (pkgEntry) {
    try {
      const inner = JSON.parse(pkgEntry.data.toString("utf8"));
      if (inner.name !== pkg.name) problems.push(`package.json 里 name=${inner.name}，期望 ${pkg.name}`);
      if (!inner.engines || !inner.engines.vscode) problems.push("package.json 缺 engines.vscode");
      if (inner.main !== "./extension.js") problems.push(`package.json 的 main=${inner.main}，期望 ./extension.js`);
      if (!Array.isArray(inner.contributes?.commands) || inner.contributes.commands.length < 3) {
        problems.push("package.json 的 contributes.commands 少于 3 条");
      }
      if (!inner.contributes?.configuration?.properties) problems.push("package.json 缺 contributes.configuration");
      if (!Array.isArray(inner.contributes?.snippets)) problems.push("package.json 缺 contributes.snippets");
      if (!problems.length) notes.push(`extension/package.json 可 JSON.parse（v${inner.version}，${inner.contributes.commands.length} 个命令）`);
    } catch (e) {
      problems.push(`extension/package.json 不是合法 JSON：${e.message}`);
    }
  }

  // [Content_Types].xml / vsixmanifest 基本结构
  const ct = byName.get("[Content_Types].xml");
  if (ct && !/<Types /.test(ct.data.toString("utf8"))) problems.push("[Content_Types].xml 缺少 <Types> 根元素");
  const vm = byName.get("extension.vsixmanifest");
  if (vm) {
    const xml = vm.data.toString("utf8");
    if (!/<PackageManifest /.test(xml)) problems.push("extension.vsixmanifest 缺少 <PackageManifest> 根元素");
    if (!xml.includes(`Id="${pkg.name}"`)) problems.push("extension.vsixmanifest 的 Identity Id 与 package.json 不一致");
    if (!xml.includes(`Version="${pkg.version}"`)) problems.push("extension.vsixmanifest 的 Identity Version 与 package.json 不一致");
    if (!xml.includes('Path="extension/package.json"')) problems.push("extension.vsixmanifest 缺 package.json 的 Asset");
  }

  // 每个 JS 文件语法正确
  let jsCount = 0;
  for (const e of entries) {
    if (!e.name.endsWith(".js")) continue;
    jsCount += 1;
    try {
      // eslint-disable-next-line no-new-func
      new Function(e.data.toString("utf8"));
    } catch (err) {
      problems.push(`${e.name} 语法错误：${err.message}`);
    }
  }
  if (jsCount && !problems.some((p) => p.includes("语法错误"))) notes.push(`${jsCount} 个 JS 文件语法解析通过`);

  // 数据表能 parse 且条目 > 250
  const dataEntry = byName.get("extension/data/bwe-api.json");
  if (dataEntry) {
    try {
      const data = JSON.parse(dataEntry.data.toString("utf8"));
      if (!Array.isArray(data.apis) || data.apis.length <= 250) problems.push(`bwe-api.json 条目数 ${data.apis?.length} 不满足 > 250`);
      else notes.push(`data/bwe-api.json 可 JSON.parse（${data.apis.length} 条）`);
    } catch (e) {
      problems.push(`data/bwe-api.json 不是合法 JSON：${e.message}`);
    }
  }

  const sha = createHash("sha256").update(buf).digest("hex");
  return { ok: problems.length === 0, problems, notes, entries, sha256: sha };
}

// ============================================================================
// main
// ============================================================================

function main() {
  if (!existsSync(join(EXT_ROOT, "extension.js"))) {
    console.error("✗ 缺 extension.js，先写扩展入口再打包。");
    process.exit(1);
  }
  if (!existsSync(join(EXT_ROOT, "data", "bwe-api.json"))) {
    console.error("✗ 缺 data/bwe-api.json。先跑 node web/tools/gen-vscode-api.mjs。");
    process.exit(1);
  }

  const { vsixPath, files, zip, entries } = build();
  console.log(`[build-vsix] 打包 ${entries.length} 个条目（${(zip.length / 1024).toFixed(1)} KB）→ ${vsixPath}`);
  console.log(`[build-vsix] 来源：${EXT_ROOT}`);
  for (const f of files) console.log(`  + extension/${f.rel}`);
  const sizeKb = statSync(vsixPath).size / 1024;
  console.log(`[build-vsix] 文件大小 ${sizeKb.toFixed(1)} KB`);

  if (NO_VERIFY) {
    console.log(`\n安装：code --install-extension "${vsixPath}"`);
    return 0;
  }

  const result = verify(vsixPath);
  console.log("\n[verify] 解包自检：");
  for (const n of result.notes) console.log(`  ✓ ${n}`);
  for (const p of result.problems) console.log(`  ✗ ${p}`);
  if (!result.ok) {
    console.error(`\n✗ vsix 自检失败（${result.problems.length} 项）`);
    return 1;
  }
  console.log(`  ✓ sha256=${result.sha256}`);
  console.log(`  ✓ 解包条目数=${result.entries.length}`);
  console.log(`\n✅ vsix 已生成并解包校验通过`);
  console.log(`\n安装（在 VS Code 里执行）：`);
  console.log(`  code --install-extension "${vsixPath}"`);
  console.log(`或在「扩展」面板右上角 ... → 从 VSIX 安装 → 选上面这个文件。`);
  return 0;
}

process.exit(main());
