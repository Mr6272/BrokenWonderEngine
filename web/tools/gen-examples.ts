/**
 * 生成 web/examples 下的 .bwproj 示例工程。
 *
 * 示例工程与编辑器「文件 → 扫雷示例 / 换装示例」共用 web/src/data/examples.ts，
 * 不会出现"菜单里是新的、examples 里是旧的"两套数据。
 *
 * 注意：这里只生成「用代码搭出来」的两个示例（扫雷 / 换装）。
 * 另外两个示例 —— 俯视角JS示例、涌现沙盘 —— 是**数据文件**：
 *   - 体量大（100KB+，含 6 段 JS 脚本与内联 PNG 素材），由 .tmp_rel8/gen-js-demo.mjs、
 *     .tmp_rel8/gen-emergence-demo.mjs 生成后直接进仓库；
 *   - 编辑器通过 `import x from "../../examples/xxx.bwproj"`（esbuild json loader）引用它们，
 *     所以 web/examples 下的那份文件就是唯一事实来源，本脚本不会覆盖它们。
 *
 * 运行：npm run gen:examples
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDressupProject, createMinesweeperProject } from "../src/data/examples.ts";

const outDir = resolve(process.cwd(), "web", "examples");
mkdirSync(outDir, { recursive: true });

const jobs = [
  { file: "扫雷示例.bwproj", project: createMinesweeperProject() },
  { file: "换装示例.bwproj", project: createDressupProject() }
];

for (const job of jobs) {
  const target = resolve(outDir, job.file);
  writeFileSync(target, JSON.stringify(job.project, null, 2) + "\n", "utf8");
  console.log(`wrote ${target}`);
}
