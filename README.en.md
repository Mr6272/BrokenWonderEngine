# BrokenWonderEngine · BWE

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Java](https://img.shields.io/badge/runtime-Java%2017~25-orange.svg)](tools/bwe.ps1)
[![Electron](https://img.shields.io/badge/editor-Electron%2037%20%2B%20TypeScript-9feaf9.svg)](desktop/README.md)

[中文](README.md) | **English**

> A hand-built 2D top-down game engine: Java + JOGL runs the game, TypeScript builds the editor.
> You lay out scenes, wire modules and write JS in the browser or desktop editor, press one button and get a Windows EXE / Android APK.

![BWE Studio editor overview](docs/readme/raw/editor/hero.png)

---

## What this is

BWE is two pieces, with a clear line between them:

| Part | Stack | What it does |
|---|---|---|
| **BWE Studio** | TypeScript + Electron 37 | Visual editor: lay out scenes, wire modules, write scripts, bake lighting, preview, package |
| **BWE Runtime** | Java 17~25 / JOGL 2.1 fixed-function pipeline | Reads `boot.json` and runs the game: rendering, physics, scripting (Rhino 1.7.15, ES5) |

The editor and the runtime talk through a single **mapping contract** ([`docs/mapping-contract.md`](docs/mapping-contract.md)):
a `.bwproj` project file becomes `Build/boot.json` plus assets, and the runtime reads that. If either side changes behavior, the other side has to change with it, or the picture comes out wrong.

## What runs today

The editor ships 10 projects you can open directly (`web/examples/*.bwproj`), from a 3-object minesweeper to a 1309-object city,
all of them produced by the same engine on real data:

| Minesweeper (扫雷), playable, landscape and portrait | Alien Shooter (孤胆枪手), 8-script shooter |
|---|---|
| ![Minesweeper](docs/readme/raw/runtime/minesweeper-landscape-fit.png) | ![Alien Shooter](docs/readme/raw/runtime/alien-shooter.png) |

| 2D lighting (2D光照): baked + dynamic + occlusion | Open world city (开放世界城市): 1309 objects / 101 assets |
|---|---|
| ![2D lighting](docs/readme/raw/runtime/lighting-2d.png) | ![Open world city](docs/readme/raw/runtime/open-world-city.png) |

| Vampire Survivors (吸血鬼幸存者) | Emergence sandbox (涌现沙盘): fire / smoke / sensing AI |
|---|---|
| ![Vampire Survivors](docs/readme/raw/runtime/vampire-survivors.png) | ![Emergence sandbox](docs/readme/raw/runtime/emergence-sandbox.png) |

> Every PNG above comes from the **real engine** offscreen-rendered: `.bwproj` → `boot.json` → JDK runs `OffscreenFrameDump`
> (FBO offscreen GL, advance 45 frames, then `glReadPixels` to disk). These are not UI screenshots and not design mockups.
> Per-image pixel statistics, engine-reported draw calls, and the "3 frames vs 45 frames" animation comparison are all in
> [`docs/readme/raw/runtime/SHOTS.md`](docs/readme/raw/runtime/SHOTS.md) and can be checked entry by entry.

## What the editor looks like

The whole UI follows VS Code's structure: activity bar / sidebar / multi-tab editor area / bottom panel / status bar / `Ctrl+Shift+P` command palette.

| Scripts (JS / Yarn, both languages) | Modules and rules |
|---|---|
| ![Script panel](docs/readme/raw/editor/script.png) | ![Modules panel](docs/readme/raw/editor/modules.png) |

| AI assistant (with token metering) | Command palette |
|---|---|
| ![AI panel](docs/readme/raw/editor/ai.png) | ![Command palette](docs/readme/raw/editor/palette.png) |

<details>
<summary><b>More UI screenshots (explorer / prefabs / packaging / lighting / settings / minimum window / dark theme)</b></summary>

| Explorer + canvas | Prefab |
|---|---|
| ![Explorer](docs/readme/raw/editor/explorer.png) | ![Prefab](docs/readme/raw/editor/prefabs.png) |

| Packaging panel | Packaging workbench |
|---|---|
| ![Packaging](docs/readme/raw/editor/package.png) | ![Packaging workbench](docs/readme/raw/editor/package-workbench.png) |

| Lighting bake panel | Settings |
|---|---|
| ![Lighting](docs/readme/raw/editor/lighting.png) | ![Settings](docs/readme/raw/editor/settings.png) |

| 1280×720 minimum window | midnight dark theme |
|---|---|
| ![Minimum window](docs/readme/raw/editor/mobile.png) | ![Dark theme](docs/readme/raw/editor/midnight.png) |

</details>

## Running it in three minutes

### Double-click and it opens

On Windows, double-click **`start.cmd`** in the repo root, wait for it to finish five things, and the editor window comes up by itself:

```
 [1/5] Node.js v24.16.0
 [2/5] npm dependencies: already installed
 [3/5] Electron runtime: already vendored
 [4/5] Building front-end bundle (web/dist/studio.js)
 [5/5] Starting BWE Studio...
```

All it does is the five commands below, strung together: install dependencies, rebuild Electron, bundle the front end, launch. Every step is idempotent:
a step already done is skipped on the next run, and if Node is missing or the network is down it stops where it is and tells you what is missing, rather than leaving you with a white window.

On Linux / macOS / Git Bash use `./start.sh`, which runs the same five steps. But **the desktop shell only runs on Windows**: `desktop/vendor/electron/`
in the repo holds win32-x64 binaries, and `fetch-electron.mjs` unpacks exactly that Windows zip.
So on Linux / macOS, `start.sh` says so and falls back to the web editor (`npm run dev`, which needs no Electron).

Both scripts pass arguments through, so `start.cmd --shot=out.png --size=1600x1000` goes straight into screenshot mode.

> The editor UI and every screenshot below come from **the same front-end bundle**. `start.cmd` compresses "open it" into one double-click;
> there is no second launch path and no hidden switch.

### Just want the editor (four manual steps)

Getting the desktop build running needs three things: the Node dependencies (`esbuild` bundles the front end), the Electron runtime, and a built `web/dist/studio.js`.
That last one is in `.gitignore`, so you **have to build it yourself once**; the Electron runtime is not committed either (`desktop/vendor/`, 317MB),
but it can be rebuilt offline from the local cache. Once it is running you do not need a local server.

```powershell
git clone https://github.com/Mr6272/BrokenWonderEngine.git
cd BrokenWonderEngine

node desktop/tools/fetch-electron.mjs   # unpack offline from the local electron cache, no network
npm install                             # installs only esbuild + typescript (for the front-end bundle)
npm run build                           # esbuild bundles the front end → web/dist/studio.js
npm run desk                            # start the desktop build
```

Once it opens, use `文件 → 扫雷示例` (the File menu, then the minesweeper sample), or press `Ctrl+Shift+P` and search for 示例.
Then click 预览 (Preview) in the toolbar to play it.

### Running from the command line

You can skip the editor entirely. Every capability in the repo has a command:

```powershell
# start the desktop build (= step 5 of double-clicking start.cmd)
npm run desk
node desktop/main.mjs

# capture screenshots (it relaunches itself with the vendored electron.exe, then exits)
node desktop/main.mjs --shot=out.png --size=1600x1000
node desktop/main.mjs --shot=out.png --size=1600x1000 --tap='[data-activity="modules"]'
node desktop/main.mjs --verify                 # two-size self-check: theme / horizontal overflow / non-background ratio

# web build (build + start a local server)
npm run dev                                     # → http://localhost:5273
npm run serve                                   # server only (assumes a build already ran)
npm run watch                                   # rebundle the front end on change

# render one project to PNG with the real engine, offscreen
node web/tools/render-minesweeper.mjs

# package to EXE (jpackage) / self-check after packaging
npm run desk:pack
npm run desk:verify
```

Every flag `desktop/main.mjs` accepts: `--shot=<png>`, `--size=WxH`, `--tap=<selectors,...>`, `--tap-seq=<steps>`,
`--probe=<json>`, `--probe-dom=<json>`, `--e2e-script=<js>`, `--e2e-out=<json>`, `--console`, `--verify`,
`--user-data=<dir>`, `--ipc-probe=<json>`.

### Want to run the Java runtime (preview / packaging / self-checks all need it)

You need **JDK 17~25**.

> ⚠ **Do not use JDK 26 to open a preview / playtest window.** JOGL 2.1 depends on `java.applet.Applet`, and JDK 26 removed it,
> so real AWT window initialization throws `NoClassDefFoundError: java/applet/Applet`.
> (Compilation, windowless tests and offscreen rendering all work on 26; the window path is the only one that breaks.)
> `findRuntimeJdk()` in `web/tools/package-bwe.mjs` picks within 17~25 automatically.

```powershell
.\tools\bwe.ps1 build     # compile all Java sources → .tmp_build\bin
.\tools\bwe.ps1 test      # compile + run 7 test suites
.\tools\bwe.ps1 run ScriptSelfTest        # run a single test class
```

`tools/bwe.ps1` also accepts a passthrough fifth positional form: `offscreen <boot.json> <outPrefix> [frames] [w] [h]`.

### Web build (no Electron)

```powershell
npm install
npm run dev      # build and open http://localhost:5273
```

The web build needs `serve.mjs` running, because script diagnostics, packaging and playtest all hang off its `/api/*`. The desktop build moved the same
capabilities into the Electron main process (sharing the one piece of business logic in `web/tools/api-core.mjs`), so it does not need it.
`api-core.mjs` implements 7 top-level capabilities: `js-check`, `script-complete`, `script-quickinfo`,
`script-file`, `open-in-vscode`, `quick-run`, `package-bwe`.

## Core concepts

### Two runtimes, each with its own job

The repo holds two engines and keeps both **on purpose**. That is a deliberate arrangement, not uncollected leftovers:

```
 Studio Runtime (where games run)
   .bwproj ──packageBwe.ts──> Build/boot.json + Build/scripts/*.js
        └──> Studio.runtime.TopDownRuntime
               ├ Actor (entity, a plain data row)
               ├ Viewport (the only world↔screen conversion)
               ├ sprite batching / solid-color batching
               └ ScriptEngine (Rhino ES5, bwe.* namespaces)

 Legacy Core (old core, kept runnable)
   Core.GameSekai / Framework.GameObject + IAbility
   Job: keep the historical demos from regressing, and serve as the reference implementation and test target for ability-component lifecycles
```

The two do not call into each other. They share only the `lib/` dependencies. Why they are split and why they are not merged
is written up in [`docs/open-world-architecture.md`](docs/open-world-architecture.md) §1, with evidence.

### Ability components (Ability, old core)

`GameObject` is a container for a set of abilities. Behavior comes from composition:

```java
GameObject go = new GameObject();          // TransformAbility attached automatically
Renderer2DAbility renderer = new Renderer2DAbility();
renderer.SpriteObj = new Sprite(SpriteWrapMode.Clamp, "Art/角色", "待机", 66);
go.AddAbility(renderer);                   // single entry point: OnInit -> OnAdded -> add to list
```

Lifecycle: `OnInit()` → `OnAdded(go)` → `OnUpdate()` every frame → `OnRemove()` on destroy.

### Fixed-step update pipeline

`GameSekai.Update()` advances on a **fixed 1/60 second step** (real-time accumulation plus an accumulator), so logic, physics and coroutines are independent of frame rate:
a dropped frame does not slow the game down, and a high-refresh display does not speed it up. On the render side, UI tweens and sprite animation use the real `deltaTime`.

Per-frame order: logic update (snapshot iteration, so objects can be added and removed safely) → Transform written into the JBox2D Body → physics step (velocity/position iterations 8/3)
→ Body synced back to Transform → custom collision pairing → coroutine advance.

### Scripts (Rhino ES5)

The runtime is **Rhino 1.7.15** executing **ES5**. The `bwe` global object is implemented entirely on the Java side; there are no JS prelude scripts.

```js
function onStart(ctx) {
  ctx.self.setPos(120, 80);
}
function onUpdate(ctx, dt) {
  if (bwe.input.key("W")) ctx.self.move(0, -120 * dt);
}
```

A few hard rules (get them wrong and you get a runtime error or a silent no-op):

| Rule | What it means |
|---|---|
| No `setTimeout` / `setInterval` | Use `bwe.after` / `bwe.every` / `bwe.cancel` (they run on game time and respect pause and `timeScale`) |
| No `import` / `require` | Scripts call into each other with `bwe.call(script, fn, ...args)` |
| Arrays start at 0 | This is JS, not Lua: `array[0]` is the first item |
| Property values are always strings underneath | Same shape as the editor; use `e.prop(k, def)` to coerce by def's type |
| Boolean text is `"开"` / `"关"` | When reading, `"开"`, `"true"` and `"1"` all count as true |
| Scene switches clear hooks | `bwe.scene.switchTo` clears every `bwe.on` hook, and top-level script code runs once and does not run again; hooks must be named, and inside `onStart`/`onSceneStart` you call `bwe.off` before `bwe.on` |

Script errors do not stop the game: they go into `Build/bwe.log` in the format `[脚本错误] <script>:<line>: <message>`, and the same script at the same line reports once.

### Modules (visual building blocks)

51 built-in modules across 9 categories. Drag one in and it runs, parameters are editable in a panel, no code needed:

| Category | Count | A few examples |
|---|---|---|
| Move | 8 | move toward player, patrol, wander, pathfind, pushable, locked |
| Rendering | 6 | eight-way facing, play once, blink, shadow, sort by Y, glow |
| Detection | 6 | collider, range, distance, line of sight, on-tile test, overlap |
| Events | 7 | click, enter/leave trigger zone, timer, variable, invoke, condition |
| Combat | 6 | health, melee, projectile, on damage, on death |
| Dialogue | 4 | speech bubble, dialogue box, branch choice, interact |
| Feedback | 6 | sound effect, music, effect, screen shake, scene switch, camera follow |
| Grid | 4 | board, tile rendering, reveal rules, flag rules |
| Gameplay | 4 | object script, minesweeper board, dress-up part, dress-up wardrobe |

Module names in the editor are "Chinese action + Unity English name", for example 朝玩家移动 Follow Target,
and parameter names carry their units, for example 移动速度 Move Speed (px/s). Every module ships with defaults filled in, so it runs the moment you drag it into the scene.

Modules and scripts **coexist without fighting**: modules supply the default behavior, scripts add a layer of logic on top.

### 2D lighting

Lighting keeps one **lightmap** covering the whole scene. It does not draw a separate circle per light:

| Mode | Behavior |
|---|---|
| `baked` | Bake a static base map in the editor (occlusion shadows computed offline) |
| `dynamic` | Computed every frame at runtime (throttled by `dynamicFps`) |
| `both` | Baked map as the base plus dynamic light on top |

The script-side `bwe.light` has 12 members: master switch / ambient light / darken (day↔night without touching scene data),
attach a light to an entity (a torch or a headlight that follows it), and add temporary light at world coordinates (explosion flash).

### Emergent simulation

The engine supplies only four composable layers, material → field → sensing/memory → physics. **Behavior is composed in JS, with no hard-coded levels.**
A typical chain: light a fire → grass self-ignites and spreads → it reaches a fuel drum and the fire surges → it burns through a wooden wall and opens a path → smoke blocks line of sight → guards hear the noise and come running → a water channel cuts the fire line.

## How the screenshots are made (reproducible)

Both kinds of screenshot are **produced by running code**, not captured by hand:

```powershell
# editor UI: a real Electron window with isolated userData, exits when done
node desktop/main.mjs --shot=out.png --size=1600x1000 --tap='[data-activity="modules"]'

# game frame: real engine offscreen GL render, read pixels after advancing 45 frames
node web/tools/render-minesweeper.mjs
```

`--tap` takes a list of CSS selectors and clicks them in order before the shot, so it can also capture what a panel looks like once opened.
`--verify` additionally asserts theme, horizontal overflow and non-background pixel ratio, which guards against the fake-green case of a white window exiting 0.

## Project structure

```
src/                          Java engine (202 files / 62550 lines)
├── Studio/runtime/           Studio runtime (72 files / 44990 lines), the one that runs boot.json
│   ├ TopDownRuntime.java      main loop + drawing
│   ├ ScriptApi/World/Prefab…  Java implementation of the bwe.* namespaces (41 namespaces / 437 members, 38 of them under bwe.*)
│   ├ OffscreenFrameDump.java  offscreen render capture tool (it produces this README's game screenshots)
│   └ Minesweeper/GridModules  built-in gameplay and grid system
├── Core/                     old core: GameSekai main loop, physics, scene, collision, coroutines
├── Framework/                old core: ability components (GameObject, Transform/Renderer/Collider/Camera)
├── UI/                       screen-space UI (JSON layout + tween)
├── Tool/                     Log / KeyManager / ImgLoader / TextureCache / FileManager
└── UserUsage/                historical demos (侠客 Xiake, 孟婆 Mengpo)

web/                          editor front end (59 .ts files / 32915 lines)
├── src/app/                  editor body: canvas, editor, packageBwe, lightBake…
├── src/panels/               23 panel files: scripts, modules, prefabs, AI, lighting, search…
├── src/ui/                   shell: activity bar, tabs, command palette, toast
├── src/data/                 51 module definitions, sample projects, API doc data
├── styles/                   cream.css (default theme) + app.css
├── examples/                 10 .bwproj sample projects
└── tools/                    40 entry points (verify-* / gen-* / serve.mjs / package-bwe.mjs and others)

desktop/                      Electron desktop shell (63 .mjs files / 21640 lines)
├── main.mjs                  bootstrap: if not inside Electron, relaunch itself with the vendored electron.exe
├── lib/app-main.mjs          main process + embedded API (shares api-core.mjs with the web build) + screenshot/probe/self-check modes
├── lib/ai/                   AI layer: routing, prefix cache, pruning, compression, knowledge base, 13 tools
└── test/                     23 unit tests

docs/                         documentation (41 .md files / 20702 lines)
├── api/                      JS API manual (18 content pages + 1 index page, Unity Scripting API style)
├── mapping-contract.md       editor → engine mapping contract (change either side and sync both)
└── _fragments/               delivery reports for each round of work

lib/                          7 jars: jogl-all 2.1.2, gluegen-rt 2.1.2, jbox2d 2.1.2, gson 2.13.1, rhino 1.7.15
```

## Self-checks

The discipline in this repo: **every capability has a command that proves it still works.** Nothing is verified by eyeballing.

```powershell
# Java side: 7 test suites, 396 assertions (needs JDK 17~25)
.\tools\bwe.ps1 test

# Java 8 compatibility gate (packaging uses --release 8, so any Java 10+ API fails on the spot)
npm run check:java8

# TypeScript type check
npm run typecheck

# API four-way consistency: Java ↔ bwe.d.ts ↔ apiDocs.ts ↔ docs/api
npm run verify:apidocs

# editor → packaging → Java runtime full round trip
npm run verify:roundtrip
npm run verify:uiscene
npm run verify:openworld

# built-in samples: field completeness (interface level) + panels do not crash (real Electron end to end)
npm run verify:example-fields
npm run verify:example-panels

# everything at once
npm run verify:all
```

Measured results (2026-11-11, local JDK 25 / Node 24.16):

| Command | Result |
|---|---|
| `tools/bwe.ps1 test` | 7/7 suites pass, all 396 assertions green |
| `npm run typecheck` | 0 errors |
| `npm run verify:roundtrip` | 19/19 pass |
| `npm run verify:uiscene` | 47/47 pass |
| `npm run verify:openworld` | 51/51 pass |
| `npm run verify:example-fields` | 34/34 pass |
| `npm run verify:example-panels` | 32/32 pass |
| `npm run check:scripts` | no type errors in any script |
| `npm run verify:apidocs` | 0 "fabricated / unimplemented"; 162 "missing docs" |

The last two exist for one specific bug: 6 of the projects under `web/examples/` predate the `prefabs` field,
and "load built-in sample" went through `cloneProject()`, which bypassed the field fallback in `normalizeProject()`.
The prefab panel then rendered a few stray characters and threw `TypeError: ... undefined (reading 'length')`.
`verify:example-fields` asserts the fields at the interface level; `verify:example-panels` loads all 7 samples
through the command palette in a real Electron window, opens the prefab panel, and checks that **the project name
actually changed** (so that 7 loop iterations are not silently testing the same project).

`verify-apidocs` checks whether the members named in the docs actually exist in Java.
The current verdict is 0 fabricated, which says the docs are not overclaiming. Those 162 "code exists, docs do not say so" entries are real debt.

The script has two modes, do not mix them up: `verify:apidocs` passes `--strict`, which also fails on
"missing docs" (exit code 1) and is what CI should use; `verify:apidocs:soft` only fails on
"fabricated / unimplemented", and that is what `verify:all` uses.
(The original `verify:all` started with the `--strict` variant, so it had **never passed** while those
162 entries were outstanding, and none of the later steps ever ran.)

Two places where we already know the docs and the actual implementation disagree, kept in plain sight:

- `tools/bwe.ps1` hard-codes the JDK path to `jdk-25.0.3.9-hotspot` and throws if it is missing.
  It does not implement "pick one JDK in 17~25"; the real range picker is `RUNTIME_JDK_MIN = 17` / `RUNTIME_JDK_MAX = 25`
  in `web/tools/package-bwe.mjs`.
- The comment in `check-java8.mjs`'s `findJavac()` says "prefer JDK 17~25", while the code is `return candidates[0]`
  with no version check. Point `JAVA_HOME` at JDK 26 and it compiles with 26 and still passes.

JDK 26 does not break everything either: compilation, windowless tests and offscreen rendering all run. **The part that breaks is the real JOGL AWT window**
(`JAWTWindow.determineIfApplet` → `NoClassDefFoundError: java/applet/Applet`).
So "do not use 26" is about preview and playtest windows, not every scenario.

## AI assistant

The editor keeps an AI column on the right, and the design goal is **saving tokens**: local zero-token routing, a stable prefix cache, tools injected on demand,
result pruning, layered compression, lossless continuation. The bottom of the panel shows the cache hit rate and three token counters live.

The AI has 13 tools, 4 of them write-class, all built around the **structured project model** instead of emitting a blob of script text:

| Kind | Tools |
|---|---|
| Read | `ReadFile`, `ReadToolResult`, `SceneDigest`, `SearchApi`, `ListScripts`, `ReadScript`, `ProjectDigest` |
| Write | `WriteScript`, `PatchScript`, `DeleteScript`, `ApplyProjectOps` |
| Knowledge | `SearchKnowledge`, `ReadKnowledge` |

`ApplyProjectOps` is transactional: a plan either succeeds as a whole or rolls back as a whole, leaving no half-built scene.
Without an API key it runs a local mock demo mode (the panel still works, but it **does not pretend the call went through**).

## Known limits

This is an engine built for personal use. Writing the limits down is more useful than hiding them:

- Rendering is the **OpenGL fixed pipeline** (`glBegin/glEnd` plus display lists). Textures are shared by path and same-texture batches are merged
  (measured: `glBegin` drops from 162 to 7 per frame with textures, 3575 to 20 per frame with solid-color tiles, **with bit-identical output pixels**),
  but there is no move to VBO or atlas batching yet.
- Two collision entry points coexist: JBox2D contacts (physics) and `CollisionSystem` pairing (fires every frame, with no enter/stay/exit semantics).
- Coroutines are a callback interface (`Coroutine.update()`), not a language-level yield.
- There is a fair amount of global state (`GameSekai.GameObjects` and other static fields). Enough for single-window demos; multi-scene and multi-window work needs it collapsed into instances.
- A documentation debt of 162 entries where the code exists and the docs do not mention it (see above).

## Documentation

| Document | What it covers |
|---|---|
| [`docs/api/`](docs/api/README.md) | **JS scripting API manual** (41 namespaces / 437 members, Unity Scripting API style) |
| [`docs/scripting-api.md`](docs/scripting-api.md) | Script system contract (editor / exporter / runtime / docs all follow it) |
| [`docs/mapping-contract.md`](docs/mapping-contract.md) | Editor → engine mapping contract (coordinates / sizes / draw order) |
| [`docs/open-world-architecture.md`](docs/open-world-architecture.md) | Open-world architecture design and layering principles |
| [`docs/desktop-migration.md`](docs/desktop-migration.md) | Desktop interface contract (how the web build's `/api/*` capabilities moved into the main process) |
| [`desktop/README.md`](desktop/README.md) | Desktop shell details and every command-line flag |
| [`tools/vscode-bwe/README.md`](tools/vscode-bwe/README.md) | VS Code extension (401 `bwe.` completions + 9 rule checks) |
| [`docs/readme/raw/`](docs/readme/raw/) | Evidence reports for every screenshot in this README |

## Writing scripts in VS Code

The JS / Yarn editor in the Scripts panel has two buttons: **Open in VS Code** and **Load VS Code changes**.
Scripts live inside the `.bwproj` JSON rather than as files on disk, so the server mirrors them to
`web/.build/scripts/<project>/<script>.js|.yarn` and then opens them with `code -g file:line`.

The companion **BWE Script** extension provides completion / hover / signature help / rule checks for those scripts:

```powershell
node tools/vscode-bwe/build-vsix.mjs
code --install-extension "tools/vscode-bwe/dist/bwe-script-0.1.0.vsix"
```

All 9 rule checks target real ES5/Rhino traps: `import` / `require` / `export`, browser host objects,
`setTimeout`/`setInterval`, and touching `ctx.self` inside `onSceneStart`. None of these exist at runtime.

## License

MIT, see [`LICENSE`](LICENSE). Both `package.json` and `desktop/package.json` declare `"license": "MIT"`.

A few things worth knowing before you use it:

- The dependencies in `lib/` carry their own licences, and none of them is MIT:

  | Dependency | Licence |
  |---|---|
  | JOGL 2.1.2 / GlueGen 2.1.2 | [New BSD 2-Clause](https://jogamp.org/cgit/jogl.git/plain/LICENSE.txt) (with compatible Sun / SGI / LWJGL / Khronos clauses) |
  | JBox2D 2.1.2 | [zlib](http://www.jbox2d.org/) (same as upstream Box2D) |
  | gson 2.13.1 | Apache-2.0 (self-declared in the jar's `Bundle-License` field) |
  | Rhino 1.7.15 | [MPL-2.0](https://rhino.github.io/license.html) |

  MIT covers this repository's own code and does not change the terms of those libraries. MPL-2.0 is file-level
  copyleft: if you modify Rhino's own sources you must publish those files, but using it as a dependency is unaffected.
- Art assets under `Assets/`, `Art/`, and the images inlined into the sample projects come from mixed sources.
  If you plan to use them commercially, check each one first.
  The assets inside the sample projects (`web/examples/`) are currently all **generated by code**: the pixel art is drawn
  by the `gen-*` scripts under `web/tools/`, and the minesweeper set is synthesised by `tools/gen-minesweeper-assets-code.mjs`
  (sound effects and BGM included, all built from sines and noise and not based on any existing work).
  Historically the minesweeper sample used assets sliced from an external commission (with a third-party BGM); since that
  copyright is not held by this repository, they have all been replaced.
- The Electron runtime is rebuilt from the local cache at build time and is not committed.
