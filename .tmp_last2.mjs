import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const T = rd("src/Studio/runtime/TopDownRuntime.java").split(/\r?\n/);
console.log("=== TopDownRuntime: mine/grid/click \u76f8\u5173 ===");
T.forEach((l, i) => { if (/minesweeper|Minesweeper|grid|Grid|\.click\(|onPointer|handleClick/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });

const G = rd("src/Studio/runtime/GridPainter.java").split(/\r?\n/);
console.log("\n=== GridPainter: \u6570\u5b57\u989c\u8272 / \u7d20\u6750\u540d ===");
G.forEach((l, i) => { if (/#[0-9a-fA-F]{6}|COLOR|asset|hiddenAsset|mineAsset|flagAsset|DIGIT/i.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
