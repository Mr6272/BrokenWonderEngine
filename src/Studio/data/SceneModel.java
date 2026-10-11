package Studio.data;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 一个关卡/房间。俯视角 RPG 常见做法：一张地图 = 一个场景，场景间用传送口连接。 */
public class SceneModel {

    public String id = UUID.randomUUID().toString();
    public String name = "新场景";
    /** 背景提示色（画布上用于区分场景缩略图）。 */
    public String tint = "#33383F";
    /** 用于世界坐标拼接：场景原点在全局地图中的格子偏移。 */
    public int originX = 0;
    public int originY = 0;
    public int widthTiles = 60;
    public int heightTiles = 40;

    public List<Layer> layers = new ArrayList<>();
    public List<SceneObject> objects = new ArrayList<>();
    /** 进入该场景时自动播放的剧本节点名，可空。 */
    public String onEnterScript = "";
    /** 场景背景音乐资源 id，可空。 */
    public String bgmAssetId = "";

    public Layer layer(String id) {
        for (Layer l : layers) {
            if (l.id.equals(id)) {
                return l;
            }
        }
        return null;
    }

    public SceneObject object(String id) {
        for (SceneObject o : objects) {
            if (o.id.equals(id)) {
                return o;
            }
        }
        return null;
    }

    /** 供运行时导出使用：直接替换原项目的 MapData 尺寸字段。 */
    public void ensureLayerExists() {
        if (layers.isEmpty()) {
            layers.add(new Layer("默认"));
        }
    }
}
