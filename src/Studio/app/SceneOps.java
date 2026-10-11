package Studio.app;

import Studio.data.AssetEntry;
import Studio.data.AssetKind;
import Studio.data.Layer;
import Studio.data.ModuleInstance;
import Studio.data.ObjKind;
import Studio.data.SceneModel;
import Studio.data.SceneObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;

/**
 * 场景的增删改操作。
 *
 * 全部集中在这里的原因：这些操作都涉及「跨对象的一致性」（层级、坐标、素材类型、
 * 模块拷贝），散落到各个面板里写，久了必然出现某处漏处理的情况。
 */
public final class SceneOps {

    private SceneOps() {
    }

    public static SceneObject create(SceneModel scene, ObjKind kind, float x, float y) {
        SceneObject o = new SceneObject();
        o.kind = kind;
        o.name = kind.cn;
        o.x = x;
        o.y = y;
        o.layerId = scene.layers.isEmpty() ? "" : scene.layers.get(scene.layers.size() - 1).id;
        o.z = scene.objects.size();
        return o;
    }

    /**
     * 从素材生成一个对象。
     *
     * 这里承担一个重要的推断职责：素材是图还是音、多大尺寸，决定它默认是"角色/物件"
     * 还是"触发区"，避免用户每次都要手动改类型。
     */
    public static SceneObject fromAsset(AppState st, AssetEntry a, float x, float y) {
        SceneModel s = st.scene();
        ObjKind kind = switch (a.kind) {
            case AUDIO -> ObjKind.ZONE;
            case IMAGE, SEQUENCE, ATLAS -> ObjKind.PROP;
            default -> ObjKind.PROP;
        };
        SceneObject o = create(s, kind, x, y);
        o.assetId = a.id;
        o.name = a.name;
        if (kind == ObjKind.PROP) {
            // 尺寸取素材本身，没有尺寸信息时退回一格大小
            int w = a.width > 0 ? a.width : st.project().tileSize;
            int h = a.height > 0 ? a.height : st.project().tileSize;
            if (a.kind == AssetKind.ATLAS && a.cellW > 0) {
                w = a.cellW;
                h = a.cellH;
            }
            o.scaleX = 1;
            o.scaleY = 1;
            o.halfW = 0;
            o.halfH = 0;
            // 用像素尺寸记录到 props，画布按素材尺寸绘制；缩放保持 1
            o.props.put("w", String.valueOf(w));
            o.props.put("h", String.valueOf(h));
        } else if (kind == ObjKind.ZONE) {
            o.halfW = st.project().tileSize;
            o.halfH = st.project().tileSize;
            o.name = a.name + " 触发区";
        }
        return o;
    }

    /** 深拷贝（模块、标签、自定义键值一并复制）。 */
    public static SceneObject duplicate(SceneObject src) {
        SceneObject c = new SceneObject();
        c.id = UUID.randomUUID().toString();
        c.name = src.name + " 副本";
        c.kind = src.kind;
        c.x = src.x;
        c.y = src.y;
        c.z = src.z;
        c.rotation = src.rotation;
        c.scaleX = src.scaleX;
        c.scaleY = src.scaleY;
        c.halfW = src.halfW;
        c.halfH = src.halfH;
        c.layerId = src.layerId;
        c.visible = src.visible;
        c.assetId = src.assetId;
        c.animMode = src.animMode;
        c.animFps = src.animFps;
        c.tags = new ArrayList<>(src.tags);
        c.props = new LinkedHashMap<>(src.props);
        for (ModuleInstance m : src.modules) {
            ModuleInstance n = new ModuleInstance(m.defId);
            n.label = m.label;
            n.trigger = m.trigger;
            n.enabled = m.enabled;
            n.collapsed = m.collapsed;
            n.values.putAll(m.values);
            c.modules.add(n);
        }
        return c;
    }

    public static void deleteSelected(AppState st) {
        SceneModel s = st.scene();
        if (s == null) {
            return;
        }
        List<SceneObject> kill = new ArrayList<>(st.selection());
        for (SceneObject o : kill) {
            if (o.locked) {
                continue;
            }
            s.objects.remove(o);
        }
        st.clearSelection();
        st.markDirty();
    }

    /** 重新理顺 z 序号，避免多次拖动/粘贴后层级错乱。 */
    public static void normalizeZ(SceneModel s) {
        for (int i = 0; i < s.objects.size(); i++) {
            s.objects.get(i).z = i;
        }
    }

    public static Layer findLayer(SceneModel s, String id) {
        Layer l = s.layer(id);
        return l == null && !s.layers.isEmpty() ? s.layers.get(s.layers.size() - 1) : l;
    }

    /** 把对象移动到指定图层（供图层面板拖拽使用）。 */
    public static void moveToLayer(SceneModel s, SceneObject o, String layerId) {
        if (s.layer(layerId) != null) {
            o.layerId = layerId;
        }
    }
}
