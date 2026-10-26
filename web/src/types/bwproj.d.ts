/**
 * `.bwproj` 工程文件的模块声明。
 *
 * 编辑器「文件 → 示例工程」里的两个脚本示例（俯视角JS示例 / 涌现沙盘）体积较大（100KB+），
 * 直接作为**数据文件**随包打进 studio.js，而不是在 TS 里用代码堆一遍 —— 这样：
 *   - `web/examples/*.bwproj` 是唯一事实来源（也是用户能直接打开/分发的文件）；
 *   - 菜单里点开的就是磁盘上那份，不会出现「代码生成的示例」和「示例文件」两套。
 *
 * esbuild 通过 `--loader:.bwproj=json` 把 JSON 变成默认导出的对象（见 package.json 的 build/watch）。
 */
declare module "*.bwproj" {
  const project: unknown;
  export default project;
}
