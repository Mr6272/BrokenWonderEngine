package Studio.data;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 工程文件（*.bwproj）的内存模型，直接由 Gson 读写。
 * 只放数据，不放行为；所有跨面板共享的可变状态都挂在这里。
 */
public class Project {

    /** 工程格式版本，用于将来做数据迁移。 */
    public int format = 1;
    public String name = "未命名工程";
    public String author = "";

    /** 画布基准：一格多少像素（俯视角 RPG 常用 32 或 48）。 */
    public int tileSize = 32;
    public int gridW = 60;
    public int gridH = 40;

    public List<SceneModel> scenes = new ArrayList<>();
    public AssetLibrary assets = new AssetLibrary();
    /** 用户自定义规则包（模块组合的封装）。 */
    public List<RulePack> packs = new ArrayList<>();
    /** Yarn 剧本集合，键为逻辑名（如 "序章"）。 */
    public Map<String, YarnScript> scripts = new LinkedHashMap<>();
    /** 全局变量：剧本与模块共用，键值对。 */
    public Map<String, String> variables = new LinkedHashMap<>();
    /** 默认音轨设置（音量等），供运行时读取。 */
    public float masterVolume = 0.8f;

    public SceneModel scene(String id) {
        for (SceneModel s : scenes) {
            if (s.id.equals(id)) {
                return s;
            }
        }
        return null;
    }

    public RulePack pack(String id) {
        for (RulePack p : packs) {
            if (p.id.equals(id)) {
                return p;
            }
        }
        return null;
    }

    /** 新建工程时的默认场景，保证编辑器永远不会处于"零场景"状态。 */
    public static Project createDefault(String name) {
        Project p = new Project();
        p.name = name;
        SceneModel s = new SceneModel();
        s.name = "场景 1";
        s.layers.add(new Layer("地形"));
        s.layers.add(new Layer("物件"));
        s.layers.add(new Layer("角色"));
        p.scenes.add(s);
        return p;
    }
}
