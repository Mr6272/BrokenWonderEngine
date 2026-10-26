/**
 * 图标路径表。
 * 全部是 24x24 视野下的描边路径，风格统一（1.8 线宽、圆头圆角），
 * 不依赖任何图标字体或图片资源，离线可用。
 */
export const I = {
  // 文件与工程
  newFile: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  open: "M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H3zM3 10h18l-2 7a2 2 0 0 1-2 1H5a2 2 0 0 1-2-1z",
  save: "M5 3h10l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v6h6V3M8 15h8",
  import: "M12 3v11M8 10l4 4 4-4M4 20h16",
  exportImg: "M12 21V10M8 14l4-4 4 4M4 4h16",

  // 编辑
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12H8",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  trash: "M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 13l4 4L19 7",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",

  // 工具
  cursor: "M5 3l14 8-6 1.6L11 19z",
  brush: "M6 20c3 0 4-2 4-4l8-8-3-3-8 8c-2 0-4 1-4 4 0 2 1 3 3 3z",
  eraser: "M4 16l7-7 6 6-3 3H7zM14 6l4 4M3 20h18",
  zone: "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2",
  hand: "M8 13V6a1.5 1.5 0 0 1 3 0v6M11 12V5a1.5 1.5 0 0 1 3 0v7M14 12V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2a1.5 1.5 0 0 1 3 0",
  grid: "M3 9h18M3 15h18M9 3v18M15 3v18",
  snap: "M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  bounds: "M4 4h16v16H4zM4 9h16M9 4v16",

  // 视图
  zoomIn: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6M11 8v6",
  zoomOut: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9l6 6M15 9l-6 6",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",

  // 内容
  sprite: "M4 5h16v14H4zM4 16l4-4 3 3 3-4 6 6",
  sheet: "M4 5h16v14H4zM9 5v14M14 5v14M4 12h16",
  atlas: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  audio: "M9 18V6l10-2v12M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM19 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  script: "M7 3h7l5 5v13H7zM14 3v5h5M10 12h7M10 16h5",

  // 对象类型
  actor: "M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 21v-3a7 7 0 0 1 14 0v3",
  prop: "M4 8l8-4 8 4-8 4zM4 8v8l8 4 8-4V8M12 12v8",
  tile: "M3 6h9v9H3zM12 6h9v9h-9zM3 15h9v6H3zM12 15h9v6h-9z",
  spawn: "M12 3v12M12 3l-4 4M12 3l4 4M5 21h14",
  portal: "M12 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 8v6M9 11h6",
  light: "M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5V16H8v-2.5A6 6 0 0 1 12 3z",

  // 模块与功能
  module: "M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7zM4 13h7v7H4z",
  puzzle: "M4 9h3a2 2 0 1 1 0 4H4v7h6v-3a2 2 0 1 1 4 0v3h6v-4h-3a2 2 0 1 1 0-4h3V6h-6v3a2 2 0 1 1-4 0V6H4z",
  play: "M7 4l13 8-13 8z",
  stop: "M6 6h12v12H6z",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  crown: "M4 18h16l1-9-5 4-4-8-4 8-5-4z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.7.6-.7 1.1v.5M12 17h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  warn: "M12 3l9 16H3zM12 9v4M12 16h.01",
  eye: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  lock: "M6 11h12v10H6zM9 11V8a3 3 0 0 1 6 0v3",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",

  // 编辑器交互
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  wand: "M4 20l10-10M15 6l3-3M13 9l2-2M18 11l3 0M18 4v-3M21 15l2 2M17 17l2-2",
  scene: "M3 5h18v14H3zM3 15l5-5 4 4 5-5 4 4M8 9h.01",
  pack: "M12 3l9 5v8l-9 5-9-5V8zM12 12l9-5M12 12v9M12 12L3 7",
  health: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM12 10v6M9 15h6"
} as const;

export type IconName = keyof typeof I;

/** 按对象类型取图标，画布与列表共用，保证同一类型处处同形。 */
export function iconForKind(kind: string): string {
  switch (kind) {
    case "ACTOR": return I.actor;
    case "PROP": return I.prop;
    case "TILE": return I.tile;
    case "ZONE": return I.zone;
    case "SPAWN": return I.spawn;
    case "PORTAL": return I.portal;
    case "LIGHT": return I.light;
    default: return I.prop;
  }
}
