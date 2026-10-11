package Studio.data;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/** 素材库：工程内所有图片与音频的索引。 */
public class AssetLibrary {

    public List<AssetEntry> items = new ArrayList<>();

    public AssetEntry get(String id) {
        if (id == null || id.isEmpty()) {
            return null;
        }
        for (AssetEntry e : items) {
            if (e.id.equals(id)) {
                return e;
            }
        }
        return null;
    }

    public void add(AssetEntry e) {
        items.add(e);
    }

    public boolean remove(String id) {
        return items.removeIf(e -> e.id.equals(id));
    }

    /** 是否已经有同路径素材，避免重复导入同一张图。 */
    public AssetEntry findByPath(String relPath) {
        for (AssetEntry e : items) {
            if (e.path.equals(relPath)) {
                return e;
            }
        }
        return null;
    }

    public Set<String> groups() {
        Set<String> g = new TreeSet<>();
        for (AssetEntry e : items) {
            g.add(e.group == null || e.group.isEmpty() ? "未分组" : e.group);
        }
        return g;
    }

    public List<AssetEntry> inGroup(String group) {
        List<AssetEntry> out = new ArrayList<>();
        for (AssetEntry e : items) {
            String g = e.group == null || e.group.isEmpty() ? "未分组" : e.group;
            if (g.equals(group)) {
                out.add(e);
            }
        }
        return out;
    }

    /** 工程内是否引用了某素材（导出与清理时用）。 */
    public boolean isUsed(Project p, String assetId) {
        if (assetId == null || assetId.isEmpty()) {
            return false;
        }
        for (SceneModel s : p.scenes) {
            for (SceneObject o : s.objects) {
                if (assetId.equals(o.assetId)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 去掉重复 id 与空条目，读盘后调用。 */
    public void sanitize() {
        Set<String> seen = new LinkedHashSet<>();
        items.removeIf(e -> e == null || e.id == null || !seen.add(e.id));
    }
}
