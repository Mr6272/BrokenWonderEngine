// Basic default level structure
const defaultLevel = {
  name: "level_01",
  cellSize: 40.0,
  width: 17,
  height: 7,
  groundObject: "ground",
  wallObject: "wall",
  
  objectTypes: [
    { type: "player", color: "#4caf50", texture: "placeholder.png" },
    { type: "box",    color: "#795548", texture: "" },
    { type: "goal",   color: "#ff9800", texture: "" }
  ],

  objects: [
    {
      type: "player",
      tag: "player",
      enabled: true,
      x: 200.5,
      y: 20,
      z: 0,
      rotation: 0,
      scaleX: 60,
      scaleY: 60,
      selectionSize: 60,
      color: "#4caf50",
      texture: "placeholder.png" // Placeholder to demonstrate structure
    },
    {
      type: "box",
      tag: "box",
      enabled: true,
      x: 400,
      y: 100,
      z: 0,
      rotation: 0,
      scaleX: 60,
      scaleY: 60,
      selectionSize: 60,
      color: "#4caf50",
      texture: ""
    },
    {
      type: "goal",
      tag: "goal",
      enabled: false,
      x: 6.7,
      y: 200,
      z: 0,
      rotation: 0,
      scaleX: 60,
      scaleY: 60,
      selectionSize: 60,
      color: "#4caf50",
      texture: ""
    }
  ]
};

// Asset definitions for the left panel
const assetTypes = [
  { type: "player", label: "Player", color: "#4caf50", texture: "placeholder.png" },
  { type: "box", label: "Box", color: "#795548", texture: "" },
  { type: "goal", label: "Goal", color: "#ff9800", texture: "" }
];

let levelData = JSON.parse(JSON.stringify(defaultLevel));
let selectedIndex = null;
let lastClickPos = null; // 记录最后一次点击位置，便于堆叠轮换选中

let canvas, ctx;
let sceneWidthPx = 0;
let sceneHeightPx = 0;
let zoom = 1.0; 

let isDragging = false;
let dragOffset = { x: 0, y: 0 };


// --- History Management ---
let historyStack = [];
let historyPointer = -1;
const MAX_HISTORY = 50;
let isRestoring = false; // Flag to prevent saving history during undo/redo

// DOM elements
let levelInfoSpan;
let globalInspector, objectInspector, inspectTitle;
let fileInput;
let btnUndo, btnRedo; // 新增 Undo/Redo 按钮 DOM 变量

// Inspector fields
let levelNameInput, levelCellSizeInput, levelWidthInput, levelHeightInput, levelGroundInput, levelWallInput;
let objTypeInput, objTagInput, objEnabledInput, objXInput, objYInput, objZInput, objRotInput;
let toolbarTypeInput;
let toolbarColorInput;
let toolbarTextureInput; 
let defaultAddType = "player";
let defaultAddColor = "#4caf50";


let objScaleXInput, objScaleYInput, objSelectSizeInput;
function getObjectTypes() {
  if (!levelData.objectTypes) {
    levelData.objectTypes = [];
  }
  return levelData.objectTypes;
}

// 图片缓存 map
const imageMap = new Map();
function loadImage(url) {
  if (!url || imageMap.has(url)) {
    return imageMap.get(url);
  }

  const img = new Image();
  img.src = url;
  img.crossOrigin = "anonymous"; 
  img.onload = () => {
    renderScene();
  };
  img.onerror = () => {
    console.warn(`Failed to load image: ${url}`);
  };
  imageMap.set(url, img);
  return img;
}

document.addEventListener("DOMContentLoaded", () => {
  cacheDom();
  buildAssetPanel();
  bindToolbar();
  bindInspector();
  setupCanvasEvents();
  setupCanvasZoom();
  bindShortcuts(); // 绑定快捷键

  loadLevel(levelData);
  saveHistory(); // 保存初始状态
});

// --- 历史记录核心函数 ---
function updateHistoryButtons() {
    if (btnUndo) btnUndo.disabled = historyPointer <= 0;
    if (btnRedo) btnRedo.disabled = historyPointer >= historyStack.length - 1;
}

function saveHistory() {
    if (isRestoring) return;

    // 1. 清理重做状态
    if (historyPointer < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyPointer + 1);
    }

    // 2. 深拷贝并推送当前状态
    // 使用 JSON.stringify/parse 进行深拷贝 levelData
    const stateToSave = JSON.stringify(levelData);

    // 优化：如果状态没有变化，不保存
    if (historyStack.length > 0 && historyStack[historyStack.length - 1] === stateToSave) {
        return;
    }

    historyStack.push(stateToSave);
    historyPointer++;

    // 3. 限制历史记录大小
    if (historyStack.length > MAX_HISTORY) {
        historyStack.shift();
        historyPointer--;
    }
    
    updateHistoryButtons();
}

function loadState(stateJson) {
    if (!stateJson) return;
    
    isRestoring = true;
    try {
        const data = JSON.parse(stateJson);
        loadLevel(data); 
    } catch (e) {
        console.error("Failed to load history state:", e);
    } finally {
        isRestoring = false;
    }
    updateHistoryButtons();
}

function undo() {
    if (historyPointer > 0) {
        historyPointer--;
        loadState(historyStack[historyPointer]);
    }
}

function redo() {
    if (historyPointer < historyStack.length - 1) {
        historyPointer++;
        loadState(historyStack[historyPointer]);
    }
}
// --- 历史记录核心函数结束 ---


function getColorForObject(obj) {
  let base = obj.color || getDefaultColorForType(obj.type);
  if (!obj.enabled) {
    return "#555555";
  }
  return base;
}

function cacheDom() {
  canvas = document.getElementById("scene-canvas");
  ctx = canvas.getContext("2d");

  levelInfoSpan = document.getElementById("level-info");
  globalInspector = document.getElementById("global-inspector");
  objectInspector = document.getElementById("object-inspector");
  inspectTitle = document.getElementById("inspect-title");
  fileInput = document.getElementById("file-input");

  // 新增 Undo/Redo 按钮 DOM
  btnUndo = document.getElementById("btn-undo");
  btnRedo = document.getElementById("btn-redo");

  // Global inspector fields
  levelNameInput = document.getElementById("level-name");
  levelCellSizeInput = document.getElementById("level-cellsize");
  levelWidthInput = document.getElementById("level-width");
  levelHeightInput = document.getElementById("level-height");
  levelGroundInput = document.getElementById("level-ground");
  levelWallInput = document.getElementById("level-wall");

  // Object inspector fields
  objTypeInput = document.getElementById("obj-type");
  objTagInput = document.getElementById("obj-tag");
  objEnabledInput = document.getElementById("obj-enabled");
  objXInput = document.getElementById("obj-x");
  objYInput = document.getElementById("obj-y");
  objZInput = document.getElementById("obj-z");
  objRotInput = document.getElementById("obj-rot");
  objScaleXInput = document.getElementById("obj-scale-x");
  objScaleYInput = document.getElementById("obj-scale-y");
  objSelectSizeInput = document.getElementById("obj-select-size");
  toolbarColorInput = document.getElementById("toolbar-color");
  toolbarTypeInput = document.getElementById("toolbar-type-name");
  toolbarTextureInput = document.getElementById("toolbar-texture");
}

function buildAssetPanel() {
  const container = document.getElementById("asset-list");
  container.innerHTML = "";

  const types = getObjectTypes();
  types.forEach(a => {
    const item = document.createElement("div");
    item.className = "asset";
    item.draggable = true;
    item.dataset.type = a.type;

    const icon = document.createElement("div");
    icon.className = "asset-icon";
    
    // 使用图片或颜色作为资源图标背景
    const texture = a.texture;
    if (texture) {
      icon.style.backgroundImage = `url(${texture})`;
      icon.style.backgroundSize = 'cover';
      icon.style.backgroundPosition = 'center';
    } else {
      icon.style.background = a.color || "#9e9e9e";
      icon.style.backgroundImage = 'none';
    }

    const label = document.createElement("div");
    label.className = "asset-label";
    label.textContent = a.type;

    item.appendChild(icon);
    item.appendChild(label);
    container.appendChild(item);

    item.addEventListener("dragstart", e => {
      e.dataTransfer.setData(
        "text/plain",
        JSON.stringify({ type: a.type })
      );
    });
  });
}


function bindToolbar() {
  // 防一下 DOM 没取到
  if (!toolbarTypeInput || !toolbarColorInput || !toolbarTextureInput) {
    console.warn("toolbar inputs not found");
  }

  // New
  document.getElementById("btn-new").addEventListener("click", () => {
    if (!confirm("Discard current level and create a new one?")) return;
    levelData = JSON.parse(JSON.stringify(defaultLevel));
    selectedIndex = null;
    loadLevel(levelData);
    
    // 重置历史记录
    historyStack = [];
    historyPointer = -1;
    saveHistory(); 
  });

  // Save
  document.getElementById("btn-save").addEventListener("click", () => {
    saveCurrentLevel();
  });

  // Open
  document.getElementById("btn-open").addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const data = JSON.parse(evt.target.result);
        levelData = data;
        selectedIndex = null;
        loadLevel(levelData);
        
        // 重置历史记录
        historyStack = [];
        historyPointer = -1;
        saveHistory(); 
        
      } catch (err) {
        alert("Failed to parse JSON: " + err.message);
      }
    };
    reader.readAsText(file);
  });
  
  // 绑定 Undo/Redo 按钮
  btnUndo.addEventListener("click", undo);
  btnRedo.addEventListener("click", redo);


  // Color：改颜色
  toolbarColorInput.addEventListener("input", () => {
    const color = toolbarColorInput.value || "#9e9e9e";

    if (selectedIndex !== null) {
      // 有选中的物体 → 改这个物体的颜色
      const obj = getSelectedObject();
      if (!obj) return;
      obj.color = color;
      if (color !== "#555555") { 
          obj.texture = ""; 
      }
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    } else {
      // 没选中物体 → 改这个类型的默认色（如果存在）
      const typeName = (toolbarTypeInput.value || "").trim();
      if (!typeName) return;
      const types = getObjectTypes();
      const t = types.find(t => t.type === typeName);
      if (t) {
        t.color = color;
        t.texture = ""; 
        
        // 同步逻辑：将新的颜色和清空的图片同步到所有同类型物体
        levelData.objects.forEach(obj => {
            if (obj.type === typeName) {
                obj.color = color;
                obj.texture = "";
            }
        });
        
        buildAssetPanel();
        renderScene();
        saveHistory(); // **新增：保存历史记录**
      }
    }
  });

  // Texture URL：改图片
  toolbarTextureInput.addEventListener("input", () => {
    const textureUrl = toolbarTextureInput.value.trim();

    if (selectedIndex !== null) {
      // 有选中的物体 → 改这个物体的图片
      const obj = getSelectedObject();
      if (!obj) return;
      obj.texture = textureUrl;
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    } else {
      // 没选中物体 → 改这个类型的默认图片（如果存在）
      const typeName = (toolbarTypeInput.value || "").trim();
      if (!typeName) return;
      const types = getObjectTypes();
      const t = types.find(t => t.type === typeName);
      if (t) {
        t.texture = textureUrl;
        
        // 同步逻辑：将新的图片同步到所有同类型物体
        levelData.objects.forEach(obj => {
            if (obj.type === typeName) {
                obj.texture = textureUrl;
            }
        });
        
        buildAssetPanel();
        renderScene();
        saveHistory(); // **新增：保存历史记录**
      }
    }
  });

  // Add Type：增加 / 更新一个物体类型（预设）
  document.getElementById("btn-add-type").addEventListener("click", () => {
    const typeName = (toolbarTypeInput.value || "").trim();
    if (!typeName) {
      alert("Type name cannot be empty.");
      return;
    }

    const color = toolbarColorInput.value || "#9e9e9e";
    const texture = toolbarTextureInput.value.trim();
    const types = getObjectTypes();
    const existing = types.find(t => t.type === typeName);

    if (existing) {
      // 已存在 → 更新颜色 / 图片
      existing.color = color;
      existing.texture = texture;
      
      // 同步逻辑：将新的颜色和图片同步到所有同类型物体
      levelData.objects.forEach(obj => {
          if (obj.type === typeName) {
              obj.color = color;
              obj.texture = texture;
          }
      });
      
    } else {
      // 不存在 → 新增
      types.push({ type: typeName, color: color, texture: texture });
    }

    buildAssetPanel();
    saveHistory(); // **新增：保存历史记录**
  });

  // Delete Type：删除一个物体类型 + 场景里所有这个类型的物体
  document.getElementById("btn-delete-type").addEventListener("click", () => {
    const typeName = (toolbarTypeInput.value || "").trim();
    if (!typeName) {
      alert("Type name is empty.");
      return;
    }

    if (!confirm(`Delete type "${typeName}" and all its objects in the scene?`)) {
      return;
    }

    // 1. 删预设类型
    const types = getObjectTypes();
    levelData.objectTypes = types.filter(t => t.type !== typeName);

    // 2. 删场景里的所有这个类型的 object
    levelData.objects = (levelData.objects || []).filter(o => o.type !== typeName);

    // 3. 收尾
    selectedIndex = null;
    buildAssetPanel();
    renderScene();
    updateInspector();
    saveHistory(); // **新增：保存历史记录**
  });
}


function bindInspector() {
  // Global
  levelNameInput.addEventListener("input", () => {
    levelData.name = levelNameInput.value;
    updateLevelInfo();
    saveHistory(); // **新增：保存历史记录**
  });
  levelCellSizeInput.addEventListener("input", () => {
    const v = parseFloat(levelCellSizeInput.value);
    if (!isNaN(v) && v > 0) {
      levelData.cellSize = v;
      updateCanvasSize();
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });
  levelWidthInput.addEventListener("input", () => {
    const v = parseInt(levelWidthInput.value, 10);
    if (!isNaN(v) && v > 0) {
      levelData.width = v;
      updateCanvasSize();
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });
  levelHeightInput.addEventListener("input", () => {
    const v = parseInt(levelHeightInput.value, 10);
    if (!isNaN(v) && v > 0) {
      levelData.height = v;
      updateCanvasSize();
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });
  levelGroundInput.addEventListener("input", () => {
    levelData.groundObject = levelGroundInput.value;
    saveHistory(); // **新增：保存历史记录**
  });
  levelWallInput.addEventListener("input", () => {
    levelData.wallObject = levelWallInput.value;
    saveHistory(); // **新增：保存历史记录**
  });

  // Object inspector
  objScaleXInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    const v = parseFloat(objScaleXInput.value);
    if (!isNaN(v)) {
      obj.scaleX = v;
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });

  objScaleYInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    const v = parseFloat(objScaleYInput.value);
    if (!isNaN(v)) {
      obj.scaleY = v;
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });
  objSelectSizeInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    const v = parseFloat(objSelectSizeInput.value);
    if (!isNaN(v) && v > 0) {
      obj.selectionSize = v;
      renderScene();
      saveHistory();
    }
  });

  objTypeInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    obj.type = objTypeInput.value;
    renderScene();
    saveHistory(); // **新增：保存历史记录**
  });
  objTagInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    obj.tag = objTagInput.value;
    saveHistory(); // **新增：保存历史记录**
  });
  objEnabledInput.addEventListener("change", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    obj.enabled = objEnabledInput.checked;
    renderScene();
    saveHistory(); // **新增：保存历史记录**
  });
  objXInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    const v = parseFloat(objXInput.value);
    if (!isNaN(v)) {
      obj.x = v;
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });
  objYInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    const v = parseFloat(objYInput.value);
    if (!isNaN(v)) {
      obj.y = v;
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });
  objZInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    const v = parseFloat(objZInput.value);
    if (!isNaN(v)) {
      obj.z = v;
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });
  objRotInput.addEventListener("input", () => {
    const obj = getSelectedObject();
    if (!obj) return;
    const v = parseFloat(objRotInput.value);
    if (!isNaN(v)) {
      obj.rotation = v;
      renderScene();
      saveHistory(); // **新增：保存历史记录**
    }
  });

  document.getElementById("btn-delete-obj").addEventListener("click", () => {
    if (selectedIndex == null) return;
    if (!confirm("Delete this object?")) return;
    levelData.objects.splice(selectedIndex, 1);
    selectedIndex = null;
    renderScene();
    updateInspector();
    saveHistory(); // **新增：保存历史记录**
  });
}

// --- 快捷键绑定 ---
function bindShortcuts() {
    window.addEventListener("keydown", e => {
        // Ctrl on Windows/Linux, Cmd on macOS
        const isControlOrCmd = e.ctrlKey || e.metaKey; 

        if (isControlOrCmd) {
            switch (e.key.toLowerCase()) {
                case 's': // Ctrl+S / Cmd+S for Save
                    e.preventDefault();
                    saveCurrentLevel();
                    break;
                case 'z': // Ctrl+Z / Cmd+Z for Undo
                    e.preventDefault();
                    undo();
                    break;
                case 'y': // Ctrl+Y / Cmd+Y for Redo
                    e.preventDefault();
                    redo();
                    break;
            }
        }
    });
}
// --- 快捷键绑定结束 ---

// 新增：滚轮缩放事件
function setupCanvasZoom() {
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const zoomSpeed = 0.001;
    let newZoom = zoom * (1 - e.deltaY * zoomSpeed);

    // 限制缩放范围
    newZoom = Math.max(0.2, Math.min(5.0, newZoom));

    if (newZoom !== zoom) {
      zoom = newZoom;
      renderScene();
      updateLevelInfo();
      // 不需要在每次缩放时保存历史，除非你认为缩放是关键操作
    }
  });
}

function setupCanvasEvents() {
  // Drag-drop from asset panel
  canvas.addEventListener("dragover", e => {
    e.preventDefault();
  });

  canvas.addEventListener("drop", e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    let payload;
    try {
      payload = JSON.parse(e.dataTransfer.getData("text/plain"));
    } catch (err) {
      return;
    }
    if (!payload || !payload.type) return;

    const worldPos = screenToWorld(cx, cy);
    const assetType = getObjectTypes().find(t => t.type === payload.type);

    // 对象创建时，复制当前的类型默认值
    const newObj = {
      type: payload.type,
      tag: payload.type,
      enabled: true,
      x: worldPos.x,
      y: worldPos.y,
      z: 0,
      rotation: 0,
      scaleX: 60,
      scaleY: 60,
      selectionSize: Math.max(60, levelData.cellSize || 0),
      color: assetType.color || getDefaultColorForType(payload.type),
      texture: assetType.texture || "",
    };
    levelData.objects.push(newObj);
    selectedIndex = levelData.objects.length - 1;
    renderScene();
    updateInspector();
    saveHistory(); // **新增：保存历史记录**
  });

  canvas.addEventListener("mousedown", e => {
    const { x, y } = getCanvasCoords(e);
    const hitStack = hitTestStack(x, y);

    if (hitStack.length > 0) {
      const sameSpot = lastClickPos && Math.abs(lastClickPos.x - x) < 2 && Math.abs(lastClickPos.y - y) < 2;
      const currentPosInStack = hitStack.indexOf(selectedIndex);
      // 再次点击同一位置时，向下轮换选中；否则选最上方
      const nextIndex = (sameSpot && currentPosInStack !== -1)
        ? hitStack[(currentPosInStack + 1) % hitStack.length]
        : hitStack[0];

      selectedIndex = nextIndex;
      const worldPos = screenToWorld(x, y);
      const obj = levelData.objects[nextIndex];
      dragOffset.x = worldPos.x - obj.x;
      dragOffset.y = worldPos.y - obj.y;
      isDragging = true;
    } else {
      // click on empty space: deselect
      selectedIndex = null;
      isDragging = false;
    }

    lastClickPos = { x, y };
    renderScene();
    updateInspector();
  });

  window.addEventListener("mousemove", e => {
    if (!isDragging || selectedIndex === null) return;
    const { x, y } = getCanvasCoords(e);
    const worldPos = screenToWorld(x, y);
    const obj = levelData.objects[selectedIndex];
    // 拖拽时，坐标更新精确到 0.1 避免浮点数精度问题
    obj.x = parseFloat((worldPos.x - dragOffset.x).toFixed(1));
    obj.y = parseFloat((worldPos.y - dragOffset.y).toFixed(1));
    renderScene();
    refreshObjectInspectorPosition();
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
        // 拖拽完成后，保存历史记录
        saveHistory(); // **新增：保存历史记录**
    }
    isDragging = false;
  });
}

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaledX = e.clientX - rect.left;
  const scaledY = e.clientY - rect.top;

  // 将缩放后的坐标转换回原始画布坐标
  return {
    x: scaledX / zoom,
    y: scaledY / zoom
  };
}

function loadLevel(data) {
  // 1. 接管整个 levelData
  levelData = data || {};

  // 保底：至少有 objects / objectTypes
  if (!Array.isArray(levelData.objects)) {
    levelData.objects = [];
  }
  if (!Array.isArray(levelData.objectTypes)) {
    levelData.objectTypes = [];
  }

  // 2. 从 objects 里补全缺失的类型
  const types = levelData.objectTypes;
  const existing = new Set(types.map(t => t.type));

  levelData.objects.forEach(obj => {
    if (!obj || !obj.type) return;
    if (!existing.has(obj.type)) {
      types.push({
        type: obj.type,
        color: obj.color || "#9e9e9e",
        texture: obj.texture || ""
      });
      existing.add(obj.type);
    }
    // 确保 object 本身也有 texture/color 字段
    if (obj.texture === undefined) {
      obj.texture = "";
    }
    if (obj.color === undefined) {
      obj.color = getDefaultColorForType(obj.type);
    }
    if (obj.selectionSize === undefined || obj.selectionSize <= 0) {
      const fallback = Math.max(
        obj.scaleX || 0,
        obj.scaleY || 0,
        levelData.cellSize || 40
      );
      obj.selectionSize = fallback > 0 ? fallback : 40;
    }
  });

  // 3. 画布尺寸
  updateCanvasSize();

  // 4. 重新构建左边资源区
  buildAssetPanel();

  // 5. 清选中，重画
  selectedIndex = null;
  renderScene();
  updateInspector();
  updateLevelInfo();

  // 6. 顺便让工具栏显示第一个类型
  if (toolbarTypeInput && toolbarColorInput && toolbarTextureInput && types.length > 0) {
    toolbarTypeInput.value = types[0].type;
    toolbarColorInput.value = types[0].color || "#9e9e9e";
    toolbarTextureInput.value = types[0].texture || "";
  }
}

function updateCanvasSize() {
  sceneWidthPx = levelData.width * levelData.cellSize;
  sceneHeightPx = levelData.height * levelData.cellSize;
  // 保持画布本身的尺寸不变，只通过 style.width/height 影响显示尺寸
  canvas.width = sceneWidthPx;
  canvas.height = sceneHeightPx;
}

function updateLevelInfo() {
  const objCount = levelData.objects ? levelData.objects.length : 0;
  levelInfoSpan.textContent = `Name: ${levelData.name} | Size: ${levelData.width} x ${levelData.height} cells | Objects: ${objCount} | Zoom: ${zoom.toFixed(2)}x`;
}

function renderScene() {
// ... (渲染逻辑保持不变)

  if (!ctx) return;
  
  // 应用缩放，通过 style 属性放大 canvas 元素的显示
  const scaledWidth = canvas.width * zoom;
  const scaledHeight = canvas.height * zoom;
  ctx.canvas.style.width = `${scaledWidth}px`;
  ctx.canvas.style.height = `${scaledHeight}px`;

  // 清除画布内容
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // draw grid
  drawGrid();
  const objs = levelData.objects || [];

  // 先打包成 { obj, index }，保留原 index 用来跟 selectedIndex 对上
  const drawList = objs.map((obj, index) => ({ obj, index }));

  // 按 z 排序：z 小的在后面，z 大的在前面
  drawList.sort((a, b) => {
    const za = a.obj.z != null ? a.obj.z : 0;
    const zb = b.obj.z != null ? b.obj.z : 0;
    return za - zb; // 与 renderScene 一致：小的在后，大的在前
  });

  for (const item of drawList) {
    const obj = item.obj;
    const i   = item.index;

    const center = worldToScreenCenter(obj);

    const sx = (obj.scaleX != null ? obj.scaleX : 1);
    const sy = (obj.scaleY != null ? obj.scaleY : 1);
    const drawW = sx;
    const drawH = sy;
    const halfW = drawW / 2;
    const halfH = drawH / 2;
    const selectionSize = (obj.selectionSize != null && obj.selectionSize > 0)
      ? obj.selectionSize
      : Math.max(drawW, drawH);
    const selectionHalf = selectionSize / 2;

    ctx.save();
    ctx.translate(center.x, center.y);

    const angleRad = (obj.rotation || 0) * Math.PI / 180;
    ctx.rotate(angleRad);

    // 优先使用物体自身的 texture 属性
    const textureUrl = obj.texture; 

    if (textureUrl) {
      const img = loadImage(textureUrl);
      if (img && img.complete && img.naturalWidth > 0) {
        // 使用图片绘制
        ctx.drawImage(img, -halfW * 2, -halfH * 2, drawW * 2, drawH * 2);

        // 如果未启用，叠加半透明遮罩
        if (!obj.enabled) {
          ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
          ctx.fillRect(-halfW * 2, -halfH * 2, drawW * 2, drawH * 2);
        }
      } else {
        // 图片未加载完成或加载失败，退回纯色绘制
        const color = getColorForObject(obj);
        ctx.fillStyle = color;
        ctx.fillRect(-halfW, -halfH, drawW, drawH);
      }
    } else {
      // 无图片 URL，纯色绘制
      const color = getColorForObject(obj);
      ctx.fillStyle = color;
      ctx.fillRect(-halfW, -halfH, drawW, drawH);
    }

    // 绘制选中框（碰撞区域）
    if (i === selectedIndex) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(-selectionHalf, -selectionHalf, selectionSize, selectionSize);
    }

    // 绘制 Type 文本
    // ctx.fillStyle = "#fff";
    // ctx.font = "5px sans-serif";
    // ctx.textAlign = "center";
    // ctx.textBaseline = "middle";
    // ctx.fillText(obj.type, 0, 0);

    ctx.restore();
  }

}


function drawGrid() {
// ... (保持不变)
  const size = levelData.cellSize;
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;

  // vertical lines
  for (let x = 0; x <= sceneWidthPx; x += size) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, sceneHeightPx);
    ctx.stroke();
  }

  // horizontal lines
  for (let y = 0; y <= sceneHeightPx; y += size) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(sceneWidthPx, y + 0.5);
    ctx.stroke();
  }
}

function getDefaultColorForType(type) {
// ... (保持不变)
  const types = getObjectTypes();
  const t = types.find(t => t.type === type);
  return t ? (t.color || "#9e9e9e") : "#9e9e9e";
}

function getDefaultTextureForType(type) {
// ... (保持不变)
  const types = getObjectTypes();
  const t = types.find(t => t.type === type);
  return t ? (t.texture || "") : "";
}


function worldObjectToScreenRect(obj, size) {
// ... (保持不变)
  // treat obj.x, obj.y as center in world coordinates
  const half = size / 2;
  const sx = obj.x - half;
  const syWorldTop = obj.y + half;
  const sy = sceneHeightPx - syWorldTop;
  return { x: sx, y: sy, size: size };
}

function screenToWorld(cx, cy) {
// ... (保持不变)
  // canvas origin top-left; world origin bottom-left
  const wx = cx;
  const wy = sceneHeightPx - cy;
  return { x: wx, y: wy };
}

function hitTestObject(cx, cy) {
  const stack = hitTestStack(cx, cy);
  return stack.length ? stack[0] : null;
}

function hitTestStack(cx, cy) {
  const worldPos = screenToWorld(cx, cy);
  const objs = levelData.objects || [];

  // Build { obj, index } and sort by z
  const drawList = objs.map((obj, index) => ({ obj, index }));
  drawList.sort((a, b) => {
    const za = a.obj.z != null ? a.obj.z : 0;
    const zb = b.obj.z != null ? b.obj.z : 0;
    return za - zb; // Same as renderScene: smaller z goes behind
  });

  // Check from front to back (array end to start)
  const hit = [];
  for (let i = drawList.length - 1; i >= 0; i--) {
    const { obj: o, index } = drawList[i];

    const selectSize = (o.selectionSize != null && o.selectionSize > 0)
      ? o.selectionSize
      : Math.max(o.scaleX || 1, o.scaleY || 1);
    const halfW = selectSize / 2;
    const halfH = selectSize / 2;

    const minX = o.x - halfW;
    const maxX = o.x + halfW;
    const minY = o.y - halfH;
    const maxY = o.y + halfH;

    if (worldPos.x >= minX && worldPos.x <= maxX &&
        worldPos.y >= minY && worldPos.y <= maxY) {
      hit.push(index); // Order: top -> bottom
    }
  }
  return hit;
}

function updateInspector() {
  if (selectedIndex === null) {
// ... (保持不变)
    // Level inspector
    inspectTitle.textContent = "Level Settings";
    globalInspector.style.display = "block";
    objectInspector.style.display = "none";

    levelNameInput.value = levelData.name || "";
    levelCellSizeInput.value = levelData.cellSize || 40;
    levelWidthInput.value = levelData.width || 1;
    levelHeightInput.value = levelData.height || 1;
    levelGroundInput.value = levelData.groundObject || "";
    levelWallInput.value = levelData.wallObject || "";
  } else {
    const obj = levelData.objects[selectedIndex];
// ... (保持不变)
    inspectTitle.textContent = "Object Properties";
    globalInspector.style.display = "none";
    objectInspector.style.display = "block";

    objTypeInput.value = obj.type || "";
    objTagInput.value = obj.tag || "";
    objEnabledInput.checked = !!obj.enabled;
    objXInput.value = obj.x != null ? obj.x : 0;
    objYInput.value = obj.y != null ? obj.y : 0;
    objZInput.value = obj.z != null ? obj.z : 0;
    objRotInput.value = obj.rotation != null ? obj.rotation : 0;
    objScaleXInput.value = obj.scaleX != null ? obj.scaleX : 1;
    objScaleYInput.value = obj.scaleY != null ? obj.scaleY : 1;
    objSelectSizeInput.value = obj.selectionSize != null ? obj.selectionSize : Math.max(obj.scaleX || 1, obj.scaleY || 1) / 2;

    
    // 更新工具栏：显示当前物体的属性
    toolbarTypeInput.value = obj.type || "";
    toolbarColorInput.value = obj.color || getDefaultColorForType(obj.type);
    toolbarTextureInput.value = obj.texture || getDefaultTextureForType(obj.type);

  }
}

function refreshObjectInspectorPosition() {
// ... (保持不变)
  if (selectedIndex === null) return;
  const obj = levelData.objects[selectedIndex];
  objXInput.value = obj.x != null ? obj.x : 0;
  objYInput.value = obj.y != null ? obj.y : 0;
}

function getSelectedObject() {
// ... (保持不变)
  if (selectedIndex === null) return null;
  if (!levelData.objects || selectedIndex < 0 || selectedIndex >= levelData.objects.length) return null;
  return levelData.objects[selectedIndex];
}

function saveCurrentLevel() {
// ... (保持不变)
  const json = JSON.stringify(levelData, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const name = (levelData.name || "level") + ".json";
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function worldToScreenCenter(obj) {
// ... (保持不变)
  // 世界里 x 正向右，y 正向上；画布是左上 (0,0)，y 向下
  const sx = obj.x;
  const sy = sceneHeightPx - obj.y;
  return { x: sx, y: sy };
}
