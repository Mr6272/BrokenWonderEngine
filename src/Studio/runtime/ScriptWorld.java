package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;

import Studio.runtime.ScriptEngine.ScriptDef;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Random;
import java.util.Set;

/**
 * 俯视角专长的「世界模型」：网格、瓦片地图、A* 寻路、交互、刷怪器、路径跟随
 * （契约 §2.9）。这里全部是纯 Java 数据，不碰 Rhino 对象，所以可以在构造期就建好。
 *
 * <p>坐标约定与 mapping-contract 一致：像素、Y 向下、对象 (x,y) 是中心点、格子大小 = tileSize。
 * 格子坐标 {@code (cx, cy) = floor(pos / tileSize)}，格子中心 {@code (cx+0.5)*tileSize}。
 */
final class ScriptWorld {

    private final ScriptEngine engine;
    private final TopDownRuntime host;

    final int tile;
    final int cols;
    final int rows;
    /** 瓦片表：0 = 空，其它 = tileId。 */
    private final int[] tiles;
    private final Map<String, Integer> tileIds = new LinkedHashMap<String, Integer>();
    private final Set<Integer> solidIds = new HashSet<Integer>();
    private int nextTileId = 1;

    private final Random random = new Random();

    // ---------------- 交互 ----------------
    Actor interactActor;
    private final List<Scriptable> interactHandlers = new ArrayList<Scriptable>();

    ScriptWorld(ScriptEngine engine) {
        this.engine = engine;
        this.host = engine.host;
        GameData.RtScene scene = host.scene;
        this.tile = Math.max(1, scene == null ? host.data.tileSize : scene.tileSize);
        this.cols = Math.max(1, scene == null ? 1 : scene.width);
        this.rows = Math.max(1, scene == null ? 1 : scene.height);
        this.tiles = new int[cols * rows];
    }

    // ---------------- 建图 ----------------

    /** 从场景里的 TILE 对象自动建瓦片图（每个素材一个 tileId，默认算阻挡）。 */
    void buildTileMap(List<Actor> actors) {
        if (actors == null) {
            return;
        }
        for (Actor a : actors) {
            refreshAfterSpawn(a);
        }
    }

    void refreshAfterSpawn(Actor a) {
        if (a == null || a.o == null) {
            return;
        }
        // 只有「地块」进瓦片图；普通道具/刷怪生成的实体不能把格子变成墙。
        if (!"TILE".equalsIgnoreCase(a.o.kind)) {
            return;
        }
        int id = tileIdFor(a.o.assetName);
        if (!inBoundsCell(toCellX(a.x), toCellY(a.y))) {
            return;
        }
        tiles[toCellY(a.y) * cols + toCellX(a.x)] = id;
        solidIds.add(id);
    }

    private int tileIdFor(String assetName) {
        String key = assetName == null || assetName.isEmpty() ? "tile" : assetName;
        Integer id = tileIds.get(key);
        if (id != null) {
            return id;
        }
        int v = nextTileId++;
        tileIds.put(key, v);
        return v;
    }

    // ---------------- 网格 ----------------

    int toCellX(float x) {
        return (int) Math.floor(x / tile);
    }

    int toCellY(float y) {
        return (int) Math.floor(y / tile);
    }

    float cellCenterX(int cx) {
        return (cx + 0.5f) * tile;
    }

    float cellCenterY(int cy) {
        return (cy + 0.5f) * tile;
    }

    boolean inBoundsCell(int cx, int cy) {
        return cx >= 0 && cy >= 0 && cx < cols && cy < rows;
    }

    // ---------------- 瓦片地图 ----------------

    int get(int cx, int cy) {
        if (!inBoundsCell(cx, cy)) {
            return 0;
        }
        return tiles[cy * cols + cx];
    }

    void set(int cx, int cy, int tileId) {
        if (!inBoundsCell(cx, cy)) {
            return;
        }
        tiles[cy * cols + cx] = Math.max(0, tileId);
    }

    boolean solidCell(int cx, int cy) {
        if (!inBoundsCell(cx, cy)) {
            return true; // 地图外算墙
        }
        int id = tiles[cy * cols + cx];
        return id != 0 && solidIds.contains(id);
    }

    void setSolid(int tileId, boolean solid) {
        if (solid) {
            solidIds.add(tileId);
        } else {
            solidIds.remove(tileId);
        }
    }

    boolean isSolidId(int tileId) {
        return solidIds.contains(tileId);
    }

    /** 像素矩形（x/y 是左上角）是否撞墙。 */
    boolean blocked(float x, float y, float w, float h) {
        if (w <= 0f || h <= 0f) {
            return false;
        }
        int cx0 = toCellX(x);
        int cy0 = toCellY(y);
        int cx1 = toCellX(x + w - 0.001f);
        int cy1 = toCellY(y + h - 0.001f);
        for (int cy = cy0; cy <= cy1; cy++) {
            for (int cx = cx0; cx <= cx1; cx++) {
                if (solidCell(cx, cy)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 射线检测：返回 {hit(0/1), x, y, cx, cy}。
     * 世界像素坐标、Y 向下；按 1px 步进采样（格子 32px，精度足够）。
     */
    float[] raycast(float x1, float y1, float x2, float y2) {
        float dx = x2 - x1;
        float dy = y2 - y1;
        float len = (float) Math.sqrt(dx * dx + dy * dy);
        int steps = Math.max(1, Math.min(4000, (int) Math.ceil(len)));
        for (int i = 0; i <= steps; i++) {
            float t = i / (float) steps;
            float x = x1 + dx * t;
            float y = y1 + dy * t;
            int cx = toCellX(x);
            int cy = toCellY(y);
            if (solidCell(cx, cy)) {
                return new float[]{1f, x, y, cx, cy};
            }
        }
        return new float[]{0f, x2, y2, toCellX(x2), toCellY(y2)};
    }

    boolean lineOfSight(float x1, float y1, float x2, float y2) {
        return raycast(x1, y1, x2, y2)[0] < 0.5f;
    }

    // ---------------- A* ----------------

    /**
     * 网格 A*：返回世界像素点列表（首元素是起点、末元素是终点）。
     * 没有通路返回空列表；{@code smooth} 会用 lineOfSight 抽稀拐点。
     */
    List<float[]> findPath(float ax, float ay, float bx, float by,
                           boolean diagonal, int maxNodes, boolean smooth) {
        List<float[]> out = new ArrayList<float[]>();
        int sx = toCellX(ax);
        int sy = toCellY(ay);
        int gx = toCellX(bx);
        int gy = toCellY(by);
        if (!inBoundsCell(sx, sy) || !inBoundsCell(gx, gy)) {
            return out;
        }
        if (sx == gx && sy == gy) {
            out.add(new float[]{ax, ay});
            if (ax != bx || ay != by) {
                out.add(new float[]{bx, by});
            }
            return out;
        }
        final int total = cols * rows;
        final float[] gScore = new float[total];
        final float[] fScore = new float[total];
        final int[] cameFrom = new int[total];
        final boolean[] closed = new boolean[total];
        Arrays.fill(gScore, Float.MAX_VALUE);
        Arrays.fill(fScore, Float.MAX_VALUE);
        Arrays.fill(cameFrom, -1);
        int start = sy * cols + sx;
        int goal = gy * cols + gx;
        final int goalX = gx;
        final int goalY = gy;
        final float diagCost = (float) Math.sqrt(2);
        gScore[start] = 0f;
        fScore[start] = heuristic(sx, sy, goalX, goalY);
        PriorityQueue<Integer> open = new PriorityQueue<Integer>(256, new Comparator<Integer>() {
            @Override
            public int compare(Integer a, Integer b) {
                return Float.compare(fScore[a], fScore[b]);
            }
        });
        open.add(start);
        int expanded = 0;
        int limit = maxNodes <= 0 ? 2000 : maxNodes;
        boolean found = false;
        while (!open.isEmpty()) {
            int cur = open.poll();
            if (closed[cur]) {
                continue;
            }
            closed[cur] = true;
            if (cur == goal) {
                found = true;
                break;
            }
            if (++expanded > limit) {
                return out;
            }
            int cx = cur % cols;
            int cy = cur / cols;
            for (int dy = -1; dy <= 1; dy++) {
                for (int dx = -1; dx <= 1; dx++) {
                    if (dx == 0 && dy == 0) {
                        continue;
                    }
                    boolean isDiag = dx != 0 && dy != 0;
                    if (isDiag && !diagonal) {
                        continue;
                    }
                    int nx = cx + dx;
                    int ny = cy + dy;
                    if (!inBoundsCell(nx, ny)) {
                        continue;
                    }
                    int ni = ny * cols + nx;
                    if (closed[ni]) {
                        continue;
                    }
                    // 目标格即使是墙也允许到达（"走到墙边"由调用方决定）；
                    // 其它格子必须是可走格。
                    if (ni != goal && solidCell(nx, ny)) {
                        continue;
                    }
                    // 斜走不切角：两个正交邻格都必须可走。
                    if (isDiag && (solidCell(cx + dx, cy) || solidCell(cx, cy + dy))) {
                        continue;
                    }
                    float cost = isDiag ? diagCost : 1f;
                    float ng = gScore[cur] + cost;
                    if (ng < gScore[ni]) {
                        gScore[ni] = ng;
                        cameFrom[ni] = cur;
                        fScore[ni] = ng + heuristic(nx, ny, goalX, goalY);
                        open.add(ni);
                    }
                }
            }
        }
        if (!found) {
            return out;
        }
        List<Integer> cells = new ArrayList<Integer>();
        int cur = goal;
        int guard = 0;
        while (cur != -1 && guard++ < total) {
            cells.add(cur);
            if (cur == start) {
                break;
            }
            cur = cameFrom[cur];
        }
        if (cells.isEmpty() || cells.get(cells.size() - 1) != start) {
            return out;
        }
        // 反转成 start → goal，再换世界坐标
        out.add(new float[]{ax, ay});
        for (int i = cells.size() - 2; i >= 0; i--) {
            int cell = cells.get(i);
            int cx = cell % cols;
            int cy = cell / cols;
            out.add(new float[]{cellCenterX(cx), cellCenterY(cy)});
        }
        if (out.size() > 1) {
            out.remove(out.size() - 1);
        }
        out.add(new float[]{bx, by});
        if (smooth && out.size() > 2) {
            return smoothPath(out);
        }
        return out;
    }

    private static float heuristic(int x, int y, int gx, int gy) {
        int dx = Math.abs(x - gx);
        int dy = Math.abs(y - gy);
        // octile distance（允许斜走时的可采纳启发）
        return (float) (Math.max(dx, dy) + (Math.sqrt(2) - 1) * Math.min(dx, dy));
    }

    private List<float[]> smoothPath(List<float[]> points) {
        List<float[]> out = new ArrayList<float[]>();
        int i = 0;
        out.add(points.get(0));
        while (i < points.size() - 1) {
            int j = points.size() - 1;
            while (j > i + 1) {
                float[] a = points.get(i);
                float[] b = points.get(j);
                if (lineOfSight(a[0], a[1], b[0], b[1])) {
                    break;
                }
                j--;
            }
            out.add(points.get(j));
            i = j;
        }
        return out;
    }

    // ---------------- 路径跟随 ----------------

    static final class Follow {
        Actor actor;
        List<float[]> path;
        int index;
        float speed = 100f;
        float arrive = 2f;
        Function onArrive;
        ScriptDef def;
        boolean stopped;
    }

    Follow follow(Actor actor, List<float[]> path, float speed, float arrive,
                  Function onArrive, ScriptDef def) {
        stopFollow(actor);
        if (actor == null || path == null || path.isEmpty()) {
            return null;
        }
        Follow f = new Follow();
        f.actor = actor;
        f.path = path;
        f.index = path.size() > 1 ? 1 : 0;
        f.speed = speed <= 0f ? 100f : speed;
        f.arrive = Math.max(0.01f, arrive);
        f.onArrive = onArrive;
        f.def = def;
        // 起点就是实体当前位置，不用先走过去。
        if (path.size() > 1) {
            f.index = 1;
        }
        engine.follows.add(f);
        return f;
    }

    void stopFollow(Actor actor) {
        for (int i = engine.follows.size() - 1; i >= 0; i--) {
            Follow f = engine.follows.get(i);
            if (f.actor == actor) {
                f.stopped = true;
                engine.follows.remove(i);
            }
        }
    }

    private void tickFollows(float dt) {
        for (int i = engine.follows.size() - 1; i >= 0; i--) {
            Follow f = engine.follows.get(i);
            if (f.stopped || f.actor == null || f.actor.dead) {
                engine.follows.remove(i);
                continue;
            }
            float remaining = f.speed * dt;
            boolean arrived = false;
            int guard = 0;
            while (f.index < f.path.size() && guard++ < 4096) {
                float[] target = f.path.get(f.index);
                float dx = target[0] - f.actor.x;
                float dy = target[1] - f.actor.y;
                float dist = (float) Math.sqrt(dx * dx + dy * dy);
                if (dist <= f.arrive) {
                    f.actor.x = target[0];
                    f.actor.y = target[1];
                    f.index++;
                    if (f.index >= f.path.size()) {
                        arrived = true;
                        break;
                    }
                    continue;
                }
                if (dist <= remaining) {
                    f.actor.x = target[0];
                    f.actor.y = target[1];
                    remaining -= dist;
                    f.index++;
                    if (f.index >= f.path.size()) {
                        arrived = true;
                        break;
                    }
                    continue;
                }
                f.actor.x += dx / dist * remaining;
                f.actor.y += dy / dist * remaining;
                remaining = 0f;
                break;
            }
            if (arrived || f.index >= f.path.size()) {
                engine.follows.remove(i);
                if (f.onArrive != null) {
                    engine.invoke(f.def, f.onArrive, f.def == null ? null : f.def.scope,
                            new Object[]{engine.api.entity(f.actor)});
                }
            }
        }
    }

    // ---------------- 刷怪器 ----------------

    static final class Spawner {
        long id;
        String asset = "";
        String script = "";
        int count = 1;
        float interval = 2f;
        int max = 10;
        float ax, ay, aw, ah;
        Function onSpawn;
        ScriptDef def;
        float acc;
        int spawned;
        boolean stopped;
    }

    Spawner createSpawner(String asset, String script, int count, float interval, int max,
                          float ax, float ay, float aw, float ah,
                          Function onSpawn, ScriptDef def) {
        Spawner s = new Spawner();
        s.id = engine.nextSpawnerId++;
        s.asset = asset == null ? "" : asset;
        s.script = script == null ? "" : script;
        s.count = Math.max(1, Math.min(100, count));
        s.interval = Math.max(0.05f, interval);
        s.max = max;
        s.ax = ax;
        s.ay = ay;
        s.aw = aw <= 0f ? host.mapWidth() : aw;
        s.ah = ah <= 0f ? host.mapHeight() : ah;
        s.onSpawn = onSpawn;
        s.def = def;
        engine.spawners.add(s);
        return s;
    }

    void stopSpawner(Object handle) {
        long id = -1;
        if (handle instanceof Number) {
            id = ((Number) handle).longValue();
        } else if (handle instanceof Scriptable) {
            Object v = ScriptJs.get(handle, "id");
            if (v instanceof Number) {
                id = ((Number) v).longValue();
            }
        }
        for (int i = engine.spawners.size() - 1; i >= 0; i--) {
            Spawner s = engine.spawners.get(i);
            if (s.id == id || id < 0) {
                s.stopped = true;
                engine.spawners.remove(i);
            }
        }
    }

    private void tickSpawners(float dt) {
        for (int i = engine.spawners.size() - 1; i >= 0; i--) {
            Spawner s = engine.spawners.get(i);
            if (s.stopped) {
                engine.spawners.remove(i);
                continue;
            }
            s.acc += dt;
            while (s.acc >= s.interval) {
                s.acc -= s.interval;
                if (s.max > 0 && s.spawned >= s.max) {
                    s.stopped = true;
                    engine.spawners.remove(i);
                    break;
                }
                for (int n = 0; n < s.count; n++) {
                    if (s.max > 0 && s.spawned >= s.max) {
                        break;
                    }
                    float x = s.ax + random.nextFloat() * s.aw;
                    float y = s.ay + random.nextFloat() * s.ah;
                    Actor a = engine.spawnScripted(x, y, s.asset, "", "PROP", 0, 0f, 0f,
                            s.script.isEmpty() ? null : s.script, null, null);
                    s.spawned++;
                    if (a != null && s.onSpawn != null) {
                        engine.invoke(s.def, s.onSpawn, s.def == null ? null : s.def.scope,
                                new Object[]{engine.api.entity(a)});
                    }
                }
                if (s.max > 0 && s.spawned >= s.max) {
                    s.stopped = true;
                    engine.spawners.remove(i);
                    break;
                }
            }
        }
    }

    // ---------------- 交互 ----------------

    void setInteractKey(int awoCode) {
        engine.interactKey = awoCode;
    }

    void addInteractHandler(Function fn, ScriptDef def) {
        engine.interactHandlers.add(new ScriptEngine.InteractHandler(fn, def));
    }

    // ---------------- 每帧 ----------------

    void tick(Context cx) {
        float dt = engine.frameDt;
        tickFollows(dt);
        tickSpawners(dt);
        tickInteract(cx, dt);
        tickPrompt();
    }

    /**
     * 场景卸载时清掉本文件持有的场景相关状态。
     *
     * <p>瓦片表 {@code tiles/solidIds} 不能清（那是<b>新场景</b>要重新建的，
     * 而 {@link ScriptEngine#buildWorldForScene()} 会直接换一个新的 {@code ScriptWorld} 实例，
     * 本方法只是为了「如果有人复用了旧实例」时不留悬空引用）。
     */
    void clearSceneState() {
        interactActor = null;
        interactHandlers.clear();
    }

    /** 调试绘制：把正在跟随的路径画成折线（{@code bwe.debug.paths(true)} 用）。 */
    void drawDebugPaths(ScriptRender render) {
        if (render == null || engine.follows.isEmpty()) {
            return;
        }
        for (int i = 0; i < engine.follows.size(); i++) {
            Follow f = engine.follows.get(i);
            if (f == null || f.path == null || f.path.size() < 2 || f.actor == null || f.actor.dead) {
                continue;
            }
            for (int j = 0; j + 1 < f.path.size(); j++) {
                float[] a = f.path.get(j);
                float[] b = f.path.get(j + 1);
                render.worldLine(a[0], a[1], b[0], b[1], "#66ccff", 1f, 0.85f);
            }
        }
    }

    private void tickInteract(Context cx, float dt) {
        int key = engine.interactKey;
        if (key <= 0 || engine.interactActor == null) {
            return;
        }
        if (!engine.pressed[key]) {
            return;
        }
        Actor target = engine.interactActor;
        if (target.dead || !target.o.visible) {
            engine.interactActor = null;
            return;
        }
        Actor player = engine.findPlayerActor();
        Object targetJs = engine.api.entity(target);
        Object playerJs = player == null ? null : engine.api.entity(player);
        for (ScriptEngine.InteractHandler h : new ArrayList<ScriptEngine.InteractHandler>(engine.interactHandlers)) {
            engine.invoke(h.def, h.fn, h.def == null ? null : h.def.scope, new Object[]{targetJs, playerJs});
        }
        engine.api.dispatchEntityEvent(target, "interact", new Object[]{playerJs});
        engine.dispatchObject(target, engine.boundScript(target), "onInteract", new Object[]{playerJs});
    }

    /** 交互提示：有 prompt 就画在最近交互物头顶（世界空间文字）。 */
    private void tickPrompt() {
        ScriptEngine.Prompt p = engine.prompt;
        if (p == null || p.text == null || p.text.isEmpty()) {
            return;
        }
        Actor target = engine.interactActor;
        if (target == null || target.dead) {
            return;
        }
        ScriptRender.Cmd cmd = engine.render.text(0f, 0f, p.text, 14f, "#ffffff", "center", 1f, true);
        if (cmd == null) {
            return;
        }
        cmd.world = true;
        cmd.x = target.x;
        cmd.y = target.y - host.drawHeight(target) / 2f - 22f;
        engine.drawCmds.add(cmd);
    }
}
