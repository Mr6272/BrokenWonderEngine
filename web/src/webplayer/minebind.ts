/**
 * 把 MineBoard 接到场景上：定位棋盘对象、路由点击、把画布刷成纹理。
 *
 * 为什么单独一个文件：player.ts 已经负责输入/时间/生命周期，扫雷这套是
 * 「引擎侧托管的领域模块」的通用范式（Java 里也是 GridModules 独立一层）。
 * 以后 tilemap / combat 这类托管模块可以走同一套绑定方式。
 */

import type { MineBoard } from "./mine";
import type { Renderer, SceneObject } from "./renderer";

/** 棋盘在场景里用哪个 assetId 占位。Java 侧同样要求场景里有一个承载对象。 */
const BOARD_ASSET_HINTS = ["mine", "grid", "board", "棋盘", "扫雷"];

export interface MineBinding {
  board: MineBoard;
  obj: SceneObject | null;
}

/** 找场景里承载棋盘的矩形对象：优先 assetId 命中，否则用面积最大的对象 */
export function findBoardObject(objects: SceneObject[]): SceneObject | null {
  let best: SceneObject | null = null;
  let bestArea = -1;
  for (const o of objects) {
    const id = String(o.assetId ?? "").toLowerCase();
    if (BOARD_ASSET_HINTS.some((h) => id.includes(h))) return o;
    const w = Math.abs(o.scaleX ?? 1) * Math.abs(o.halfW ?? 0);
    const h = Math.abs(o.scaleY ?? 1) * Math.abs(o.halfH ?? 0);
    const area = w * h;
    if (area > bestArea) { bestArea = area; best = o; }
  }
  return best;
}

/** 棋盘对象的世界矩形（中心 + 半宽高）。与 renderer.drawObject 用同一套 halfW/halfH。 */
export function boardRect(obj: SceneObject): { cx: number; cy: number; halfW: number; halfH: number } {
  return {
    cx: obj.x ?? 0,
    cy: obj.y ?? 0,
    halfW: Math.abs(obj.halfW ?? 0),
    halfH: Math.abs(obj.halfH ?? 0),
  };
}

export interface PointerHit {
  x: number;
  y: number;
  button: number;
}

/**
 * 把一次点击交给棋盘。
 * 返回 true 表示这次点击被扫雷板消费（外部可据此跳过其它拾取逻辑）。
 */
export function dispatchMineClick(board: MineBoard, obj: SceneObject | null, hit: PointerHit): boolean {
  if (!obj) return false;
  const r = boardRect(obj);
  const cell = board.cellAt(hit.x, hit.y, r.cx, r.cy, r.halfW, r.halfH);
  if (!cell) return false;
  if (hit.button === 2) {
    if (!board.rightClickFlag) return false;
    board.toggleFlag(cell.r, cell.c);
  } else {
    board.reveal(cell.r, cell.c);
  }
  return true;
}

/**
 * 把棋盘画布刷成纹理并贴到承载对象上。
 * 贴图会被拉伸铺满对象矩形（renderer 就是按 halfW/halfH 画 quad），所以这里不用改 scale。
 * paint() 内部有 dirty 标记，只有棋盘状态变了才重画；texImage2D 每帧一次，
 * 对一块 2048x2048 以内的画布是可接受的（真正的大盘面应该只在 dirty 时上传，见 TODO）。
 */
export function paintMineBoard(renderer: Renderer, board: MineBoard, obj: SceneObject | null, texId = "__mine_board"): void {
  if (!obj) return;
  const cv = board.paint();
  renderer.setTextureFromCanvas(texId, cv);
  obj.assetId = texId;
}
