/**
 * 孤胆枪手示例 · 程序化音效（零依赖，逐字节确定）。
 *
 * 全部用最基础的合成手段：白噪声 + 一阶低通/高通、RBJ 二阶带通（共振/共振峰）、
 * 指数衰减的正弦、指数扫频、简单 FM。攻击快、指数衰减。22050 Hz 单声道 16bit。
 *
 * amb_night 是 2 秒无缝循环：风声/虫鸣先多生成 0.25 s，再把尾巴等功率交叉淡化进开头；
 * 60 Hz 电流声本身在 2 s 内是整数周期，交叉淡化之后再加，所以不会在接缝处变响。
 */
import { rng, encodeWav } from "./px.mjs";

const SR = 22050;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- 合成小工具

function buf(sec) {
  return new Float32Array(Math.round(sec * SR));
}

/** 确定性白噪声 -1..1。 */
function white(seed) {
  const r = rng(seed);
  return () => r() * 2 - 1;
}

function coef(fc) {
  return 1 - Math.exp((-TAU * fc) / SR);
}

/** 一阶低通。f.set(fc) 可逐样本改截止频率。 */
function lp(fc) {
  let y = 0;
  let a = coef(fc);
  const f = (x) => (y += a * (x - y));
  f.set = (c) => {
    a = coef(c);
  };
  return f;
}

/** 一阶高通（x - 低通）。 */
function hp(fc) {
  const l = lp(fc);
  const f = (x) => x - l(x);
  f.set = (c) => l.set(c);
  return f;
}

/** RBJ 二阶带通（0 dB 峰值增益）。 */
function bp(f0, q) {
  let b0 = 0;
  let b2 = 0;
  let a1 = 0;
  let a2 = 0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const set = (fc) => {
    const w = (TAU * Math.min(fc, SR * 0.45)) / SR;
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    b0 = al / a0;
    b2 = -al / a0;
    a1 = (-2 * Math.cos(w)) / a0;
    a2 = (1 - al) / a0;
  };
  set(f0);
  const f = (x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
  f.set = set;
  return f;
}

/** 相位累加正弦振荡器：o(freq) → 当前样本。 */
function osc(phase0 = 0) {
  let p = phase0;
  return (freq) => {
    p += freq / SR;
    p -= Math.floor(p);
    return Math.sin(TAU * p);
  };
}

/** 相位累加器（0..1），给锯齿 / 方波用。 */
function phasor() {
  let p = 0;
  return (freq) => {
    p += freq / SR;
    p -= Math.floor(p);
    return p;
  };
}

/** 指数扫频：t 从 0 到 dur，频率从 f0 走到 f1，之后停在 f1。 */
function sweep(f0, f1, dur, t) {
  const k = Math.min(1, Math.max(0, t / dur));
  return f0 * Math.pow(f1 / f0, k);
}

/** 线性攻击 + 指数衰减包络。 */
function env(t, att, tau) {
  if (t < 0) return 0;
  return (att > 0 ? Math.min(1, t / att) : 1) * Math.exp(-t / tau);
}

/** 从 at 秒开始往 out 里叠加 fn(t)（t 为相对时间），最多 len 秒。 */
function add(out, at, len, fn) {
  const s = Math.round(at * SR);
  const e = Math.min(out.length, s + Math.round(len * SR));
  for (let i = Math.max(0, s); i < e; i++) out[i] += fn((i - s) / SR);
}

/** 末尾 sec 秒余弦淡出（截断尾巴防爆音）。 */
function fadeOut(out, sec) {
  const n = Math.min(out.length, Math.round(sec * SR));
  for (let k = 0; k < n; k++) {
    const i = out.length - n + k;
    out[i] *= 0.5 + 0.5 * Math.cos((Math.PI * (k + 1)) / n);
  }
  return out;
}

// ---------------------------------------------------------------- 武器

function pistol() {
  const o = buf(0.14);
  const nz = white(101);
  const crack = hp(2500);
  const body = lp(3000);
  const tail = lp(1200);
  const s = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const n = nz();
    o[i] =
      crack(n) * env(t, 0.0004, 0.007) * 1.0 +
      body(n) * env(t, 0.001, 0.02) * 0.6 +
      s(sweep(1200, 300, 0.05, t)) * env(t, 0.0008, 0.022) * 0.7 +
      tail(n) * env(t, 0.004, 0.05) * 0.3;
  }
  return fadeOut(o, 0.02);
}

function metalClack(out, at, k, gain, seed) {
  const nz = white(seed);
  const f = bp(3000 * k, 1.5);
  const p = [osc(), osc(0.3), osc(0.7)];
  const fr = [1900 * k, 3100 * k, 4700 * k];
  const am = [0.5, 0.3, 0.2];
  const thunk = osc();
  add(out, at, 0.06, (t) => {
    let v = f(nz()) * env(t, 0.0002, 0.006) * 1.4;
    for (let j = 0; j < 3; j++) v += p[j](fr[j]) * am[j] * env(t, 0.0003, 0.008);
    v += thunk(420 * k) * env(t, 0.001, 0.015) * 0.35;
    return v * gain;
  });
}

function shotgun() {
  const o = buf(0.62);
  const nz = white(201);
  const crack = hp(1800);
  const body = lp(900);
  const rum1 = lp(250);
  const rum2 = lp(250);
  const s = osc();
  add(o, 0, 0.35, (t) => {
    const n = nz();
    const w = t < 0.29 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (t - 0.29)) / 0.06);
    return (
      w *
      (crack(n) * env(t, 0.0004, 0.01) * 0.9 +
        body(n) * env(t, 0.001, 0.06) * 1.6 +
        s(sweep(110, 45, 0.2, t)) * env(t, 0.002, 0.09) * 0.9 +
        rum2(rum1(n)) * env(t, 0.01, 0.12) * 3.0)
    );
  });
  // 拉栓："咔—嚓"（向后、向前两下，第二下音高略低）
  metalClack(o, 0.42, 1.0, 0.55, 202);
  metalClack(o, 0.5, 0.82, 0.6, 203);
  return fadeOut(o, 0.02);
}

function mg() {
  const o = buf(0.09);
  const nz = white(301);
  const crack = hp(1800);
  const body = lp(1600);
  const s = osc();
  const th = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const n = nz();
    o[i] =
      crack(n) * env(t, 0.0004, 0.006) * 0.7 +
      body(n) * env(t, 0.001, 0.018) * 1.3 +
      s(sweep(700, 160, 0.04, t)) * env(t, 0.0008, 0.02) * 0.8 +
      th(sweep(140, 70, 0.06, t)) * env(t, 0.002, 0.03) * 0.7;
  }
  return fadeOut(o, 0.015);
}

function launcher() {
  const o = buf(0.25);
  const nz = white(401);
  const soft = lp(500);
  const puff = bp(900, 1);
  const s1 = osc();
  const s3 = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const f = sweep(180, 70, 0.2, t);
    const n = nz();
    const e = env(t, 0.004, 0.07);
    o[i] =
      (s1(f) + s3(f * 3) * 0.12) * e +
      soft(n) * env(t, 0.002, 0.04) * 1.2 +
      puff(n) * env(t, 0.001, 0.015) * 0.6;
  }
  return fadeOut(o, 0.03);
}

function explode() {
  const o = buf(1.0);
  const nz = white(501);
  const burst = lp(2500);
  const rum1 = lp(180);
  const rum2 = lp(180);
  const crack = hp(1500);
  const s = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const n = nz();
    burst.set(sweep(2500, 250, 0.5, t));
    o[i] =
      s(sweep(60, 30, 0.6, t)) * env(t, 0.003, 0.25) * 1.0 +
      burst(n) * env(t, 0.002, 0.18) * 1.5 +
      rum2(rum1(n)) * env(t, 0.02, 0.45) * 6.0 +
      crack(n) * env(t, 0.0004, 0.01) * 0.6;
  }
  // 碎裂噼啪声：稀疏的短促高通噪声脉冲，越往后越少越轻
  const r = rng(502);
  for (let k = 0; k < 42; k++) {
    const t0 = 0.06 + 0.8 * Math.pow(r(), 1.5);
    const d = 0.001 + r() * 0.003;
    const a = (0.15 + r() * 0.35) * Math.exp(-t0 / 0.4);
    const f = hp(1800 + r() * 2500);
    const cn = white(600 + k);
    add(o, t0, d * 6, (t) => f(cn()) * env(t, 0.0002, d) * a);
  }
  return fadeOut(o, 0.12);
}

// ---------------------------------------------------------------- 异形

function alienHit() {
  const o = buf(0.06);
  const nz = white(601);
  const wet = bp(1800, 2);
  const squish = lp(600);
  const s = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const n = nz();
    const f = sweep(520, 220, 0.04, t) * (1 + 0.25 * Math.sin(TAU * 90 * t));
    o[i] = wet(n) * env(t, 0.0004, 0.007) * 2.0 + s(f) * env(t, 0.001, 0.014) * 0.7 + squish(n) * env(t, 0.001, 0.02) * 1.0;
  }
  return fadeOut(o, 0.01);
}

function alienDie() {
  const o = buf(0.3);
  const nz = white(701);
  const wet = bp(1200, 1.5);
  const gurgle = lp(400);
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const fc = sweep(900, 250, 0.26, t);
    pc += fc / SR;
    pm += (fc * 1.41) / SR;
    const idx = 2.5 * Math.exp(-t / 0.12) + 0.4;
    const fm = Math.sin(TAU * pc + idx * Math.sin(TAU * pm));
    const wob = 1 + 0.35 * Math.sin(TAU * 38 * t);
    wet.set(sweep(1200, 500, 0.25, t));
    const n = nz();
    o[i] =
      fm * env(t, 0.006, 0.11) * wob +
      wet(n) * env(t, 0.002, 0.07) * (0.6 + 0.4 * Math.sin(TAU * 27 * t)) * 1.6 +
      gurgle(n) * env(t, 0.01, 0.1) * 1.2;
  }
  return fadeOut(o, 0.03);
}

function alienBite() {
  const o = buf(0.15);
  const nz = white(801);
  const hiss = hp(3500);
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    o[i] = hiss(nz()) * env(t, 0.025, 0.05) * 0.6;
  }
  // 咬合"咔"
  const sn = white(802);
  const snap = bp(2200, 3);
  const crunch = lp(900);
  const s = osc();
  add(o, 0.055, 0.09, (t) => {
    const n = sn();
    return snap(n) * env(t, 0.0003, 0.005) * 3.0 + s(sweep(1600, 500, 0.02, t)) * env(t, 0.0005, 0.008) * 0.8 + crunch(n) * env(t, 0.001, 0.03) * 0.9;
  });
  return fadeOut(o, 0.02);
}

function nestDie() {
  const o = buf(0.6);
  const nz = white(901);
  const goo = lp(700);
  const wet = bp(600, 1.2);
  const s = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const n = nz();
    o[i] =
      goo(n) * env(t, 0.003, 0.09) * 2.2 +
      s(sweep(220, 55, 0.25, t)) * env(t, 0.004, 0.12) * 0.9 +
      wet(n) * env(t, 0.005, 0.15) * (0.5 + 0.5 * Math.sin(TAU * 22 * t)) * 1.4;
  }
  // 冒泡：一串上滑的短正弦"啵"，越往后越稀越轻
  const r = rng(902);
  for (let k = 0; k < 14; k++) {
    const t0 = 0.08 + 0.46 * Math.pow(r(), 1.2);
    const d = 0.025 + r() * 0.025;
    const f0 = 250 + r() * 300;
    const a = (0.25 + r() * 0.35) * (1 - t0 / 0.65);
    const b = osc();
    add(o, t0, d, (t) => b(sweep(f0, f0 * 2.2, d, t)) * Math.pow(Math.sin((Math.PI * t) / d), 2) * a);
  }
  return fadeOut(o, 0.04);
}

// ---------------------------------------------------------------- 玩家 / 拾取 / 界面

function playerHurt() {
  const o = buf(0.2);
  const nz = white(1001);
  const breath = lp(2000);
  const f1 = bp(650, 5);
  const f2 = bp(1100, 6);
  const f3 = bp(2400, 8);
  const ph = phasor();
  const sub = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const f0 = sweep(145, 108, 0.18, t) * (1 + 0.015 * Math.sin(TAU * 9 * t));
    const saw = 2 * ph(f0) - 1;
    const src = saw + breath(nz()) * 0.5;
    const e = (t < 0.07 ? Math.min(1, t / 0.012) : Math.exp(-(t - 0.07) / 0.05));
    o[i] = (f1(src) * 1.0 + f2(src) * 0.6 + f3(src) * 0.25 + sub(f0) * 0.12) * e;
  }
  return fadeOut(o, 0.025);
}

function money() {
  const o = buf(0.25);
  const bell = (out, at, f, tau, gain) => {
    const a = osc();
    const b = osc();
    const c = osc();
    add(out, at, 0.25, (t) => (a(f) + b(f * 2.76) * 0.35 + c(f * 5.4) * 0.12) * env(t, 0.001, tau) * gain);
  };
  bell(o, 0, 1318.51, 0.06, 0.9); // E6
  bell(o, 0.07, 1760, 0.08, 1.0); // A6
  return fadeOut(o, 0.02);
}

function pickup() {
  const o = buf(0.15);
  const ph = phasor();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const p = TAU * ph(sweep(420, 1250, 0.11, t));
    o[i] = (Math.sin(p) + Math.sin(3 * p) * 0.33 + Math.sin(5 * p) * 0.2) * env(t, 0.004, 0.06);
  }
  return fadeOut(o, 0.02);
}

function crateBreak() {
  const o = buf(0.25);
  const nz = white(1101);
  const knockN = lp(1000);
  const s = osc();
  add(o, 0, 0.12, (t) => s(sweep(220, 140, 0.05, t)) * env(t, 0.001, 0.025) * 0.8 + knockN(nz()) * env(t, 0.001, 0.02) * 1.2);
  // 木头碎裂：一簇簇带通噪声，开头密、后面稀
  const r = rng(1102);
  for (let k = 0; k < 18; k++) {
    const t0 = 0.2 * Math.pow(r(), 1.6);
    const d = 0.004 + r() * 0.01;
    const f = bp(500 + r() * 1700, 2.5);
    const a = (0.3 + r() * 0.7) * (1 - t0 / 0.25) * 4;
    const cn = white(1200 + k);
    add(o, t0, d * 5, (t) => f(cn()) * env(t, 0.0005, d / 2) * a);
  }
  return fadeOut(o, 0.02);
}

function click(out, at, f, gain, seed) {
  const nz = white(seed);
  const h = hp(3000);
  const a = osc();
  const b = osc();
  add(out, at, 0.03, (t) => (h(nz()) * env(t, 0.0002, 0.0015) * 1.0 + a(f) * env(t, 0.0002, 0.003) * 0.6 + b(900) * env(t, 0.0005, 0.006) * 0.3) * gain);
}

function empty() {
  const o = buf(0.05);
  click(o, 0, 2600, 1.0, 1301);
  click(o, 0.018, 2200, 0.5, 1302);
  return fadeOut(o, 0.008);
}

function switchWeapon() {
  const o = buf(0.12);
  const clack = (at, k, gain, seed) => {
    const nz = white(seed);
    const f = bp(3500 * k, 1.2);
    const fr = [1250 * k, 2930 * k, 4180 * k];
    const am = [0.6, 0.35, 0.25];
    const p = [osc(), osc(0.25), osc(0.6)];
    const th = osc();
    add(o, at, 0.065, (t) => {
      let v = f(nz()) * env(t, 0.0002, 0.004) * 1.6 + th(300 * k) * env(t, 0.001, 0.012) * 0.4;
      for (let j = 0; j < 3; j++) v += p[j](fr[j]) * am[j] * env(t, 0.0003, 0.018);
      return v * gain;
    });
  };
  clack(0, 1, 1, 1401);
  clack(0.055, 1.12, 0.85, 1402);
  return fadeOut(o, 0.012);
}

function wallCollapse() {
  const o = buf(1.2);
  const nz = white(1501);
  const crack = hp(1200);
  const crunch = bp(400, 1);
  const r1 = lp(140);
  const r2 = lp(140);
  const s = osc();
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const n = nz();
    o[i] =
      crack(n) * env(t, 0.0005, 0.02) * 0.8 +
      crunch(n) * env(t, 0.001, 0.06) * 1.6 +
      r2(r1(n)) * env(t, 0.03, 0.45) * 8.0 +
      s(sweep(55, 32, 0.8, t)) * env(t, 0.01, 0.35) * 0.7;
  }
  // 碎块落地：大块是低沉的"咚"，小石子是短促的带通"嗒"
  const r = rng(1502);
  for (let k = 0; k < 56; k++) {
    const t0 = 0.05 + Math.pow(r(), 1.4);
    const a = (0.2 + r() * 0.8) * Math.exp(-t0 / 0.6);
    const cn = white(1600 + k);
    if (r() < 0.3) {
      const f = 150 + r() * 250;
      const so = osc();
      const l = lp(800);
      add(o, t0, 0.08, (t) => (so(f) * 0.8 + l(cn()) * 1.2) * env(t, 0.001, 0.025) * a);
    } else {
      const f = bp(700 + r() * 2800, 3);
      const d = 0.002 + r() * 0.004;
      add(o, t0, 0.05, (t) => f(cn()) * env(t, 0.0003, d) * a * 3.0);
    }
  }
  return fadeOut(o, 0.1);
}

function win() {
  const o = buf(1.2);
  // C5 E5 G5 C6，方波味（奇次谐波递减）
  const notes = [523.25, 659.26, 783.99, 1046.5];
  const sq = (p) => Math.sin(p) + (Math.sin(3 * p) / 3) * 0.8 + (Math.sin(5 * p) / 5) * 0.6 + (Math.sin(7 * p) / 7) * 0.4;
  notes.forEach((f, k) => {
    const ph = phasor();
    const last = k === notes.length - 1;
    add(o, k * 0.12, 1.2, (t) => {
      const vib = last && t > 0.15 ? 1 + 0.004 * Math.sin(TAU * 5.5 * (t - 0.15)) : 1;
      return sq(TAU * ph(f * vib)) * env(t, 0.004, last ? 0.5 : 0.25) * (last ? 0.9 : 0.7);
    });
  });
  // 收尾的和弦垫底（C 大三和弦低一点、轻一点），让"完成"感更足
  [523.25, 659.26, 783.99].forEach((f) => {
    const a = osc();
    add(o, 0.36, 0.84, (t) => a(f) * env(t, 0.02, 0.45) * 0.18);
  });
  return fadeOut(o, 0.18);
}

// ---------------------------------------------------------------- 环境循环

function ambNight() {
  const N = Math.round(2.0 * SR);
  const F = Math.round(0.25 * SR);
  const L = N + F;
  const raw = new Float32Array(L);
  const nz = white(1701);
  const w1 = lp(260);
  const w2 = lp(260);
  const gust = bp(480, 2.5);
  const leaves = hp(3000);
  for (let i = 0; i < L; i++) {
    const t = i / SR;
    // 2 s 周期的慢调制（t 超过 2 s 的那段自动与开头同相）
    const m = 0.75 + 0.15 * Math.sin((TAU * t) / 2 + 0.3) + 0.07 * Math.sin((TAU * 3 * t) / 2 + 1.1);
    const g = 0.5 + 0.5 * Math.sin((TAU * t) / 2 + 2.0);
    const n = nz();
    raw[i] = w2(w1(n)) * m * 9.0 + gust(n) * g * g * 0.5 + leaves(n) * m * 0.03;
  }
  // 蟋蟀：两三组短促的 4.5 kHz 颤音，全部放在交叉淡化区之外
  const chirp = (at, f, pulses, gain) => {
    for (let k = 0; k < pulses; k++) {
      const s = osc();
      const t0 = at + k * 0.032;
      add(raw, t0, 0.014, (t) => s(f) * Math.pow(Math.sin((Math.PI * t) / 0.014), 2) * gain);
    }
  };
  chirp(0.45, 4500, 4, 0.12);
  chirp(1.18, 4560, 3, 0.1);
  chirp(1.62, 4200, 4, 0.05);
  // 等功率交叉淡化：raw[N..N+F) 淡入覆盖到开头 → out[N-1] 与 out[0]（≈ raw[N]）连续
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = raw[i];
  for (let i = 0; i < F; i++) {
    const x = i / F;
    out[i] = raw[i] * Math.sin((Math.PI / 2) * x) + raw[N + i] * Math.cos((Math.PI / 2) * x);
  }
  // 60 Hz 电流声（120 个整周期 = 2 s，天然无缝）
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    out[i] += 0.022 * Math.sin(TAU * 60 * t) + 0.014 * Math.sin(TAU * 120 * t + 0.5) + 0.006 * Math.sin(TAU * 180 * t + 1.3);
  }
  return out;
}

/**
 * 循环素材的 WAV：encodeWav 会给首尾各加 3 ms 淡入淡出，循环播放时接缝处会出现 6 ms 的"凹坑"。
 * 这里按 encodeWav 同样的去直流 + 增益，把被淡化的那几十个样本改写回原值。
 */
function encodeLoop(samples, peak) {
  const work = Float32Array.from(samples);
  const wav = encodeWav(work, SR, peak); // work 已被就地去直流
  let max = 0;
  for (let i = 0; i < work.length; i++) max = Math.max(max, Math.abs(work[i]));
  const g = max > 0 ? peak / max : 0;
  const n = work.length;
  const fade = Math.min(Math.floor(SR * 0.003), Math.floor(n / 2));
  const put = (i) => wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(work[i] * g * 32767))), 44 + i * 2);
  for (let i = 0; i < fade; i++) {
    put(i);
    put(n - 1 - i);
  }
  return wav;
}

// ---------------------------------------------------------------- 导出

/** → [{ name, wav: Buffer(RIFF/WAVE 22050 Hz mono 16bit), seconds }] */
export function buildSfx() {
  const list = [
    ["snd_pistol", pistol, 0.8],
    ["snd_shotgun", shotgun, 0.85],
    ["snd_mg", mg, 0.75],
    ["snd_launcher", launcher, 0.8],
    ["snd_explode", explode, 0.9],
    ["snd_alien_hit", alienHit, 0.6],
    ["snd_alien_die", alienDie, 0.75],
    ["snd_alien_bite", alienBite, 0.7],
    ["snd_nest_die", nestDie, 0.8],
    ["snd_player_hurt", playerHurt, 0.75],
    ["snd_money", money, 0.6],
    ["snd_pickup", pickup, 0.6],
    ["snd_crate", crateBreak, 0.75],
    ["snd_empty", empty, 0.6],
    ["snd_switch", switchWeapon, 0.65],
    ["snd_wall", wallCollapse, 0.85],
    ["snd_win", win, 0.7]
  ];
  const out = list.map(([name, fn, peak]) => {
    const s = fn();
    return { name, wav: encodeWav(s, SR, peak), seconds: s.length / SR };
  });
  const amb = ambNight();
  out.push({ name: "amb_night", wav: encodeLoop(amb, 0.3), seconds: amb.length / SR });
  return out;
}
