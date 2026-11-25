import { parseScriptParams } from "./scriptParams.mjs";
const src = `bwe.params({
  speed: 100,        // 移动速度
  hp: 3 // 血量
  ,
  label: '玩家', // 名字
  alive: true,
  x: 1
});`;
const d = parseScriptParams(src);
console.log(JSON.stringify(d, null, 1));
