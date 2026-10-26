/**
 * 生成 web/examples 下的 .bwproj 示例工程。
 *
 * 示例工程与编辑器「文件 → 扫雷示例 / 换装示例」共用 web/src/data/examples.ts，
 * 不会出现"菜单里是新的、examples 里是旧的"两套数据。
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
