package Studio.data;

import java.util.UUID;

/**
 * 素材库中的一条记录。
 *
 * 路径纪律：只存**相对工程根目录**的路径（统一用 '/' 分隔）。
 * 这样整个工程文件夹搬走、拷给同事，素材引用都不会断。
 */
public class AssetEntry {

    public String id = UUID.randomUUID().toString();
    /** 展示名，默认取文件名，可改。 */
    public String name = "";
    public AssetKind kind = AssetKind.IMAGE;

    /** 单图/图集：文件相对路径。序列帧：所在文件夹相对路径。 */
    public String path = "";
    /** 序列帧专用：公共前缀，如 "待机"；实际文件为 待机1.png 待机2.png … */
    public String headName = "";
    /** 序列帧专用：帧数量。 */
    public int frameCount = 1;
    /** 序列帧编号是否从 0 开始（引擎原约定从 1 开始，这里允许覆盖）。 */
    public boolean zeroBased = false;

    /** 图集专用切分行列与单帧尺寸。 */
    public int cols = 1;
    public int rows = 1;
    public int cellW = 0;
    public int cellH = 0;

    public int width = 0;
    public int height = 0;

    /** 分组名，用于素材面板归类（如 "大侠"、"建筑"）。 */
    public String group = "";
    /** 用户备注。 */
    public String note = "";

    public AssetEntry() {
    }

    public static AssetEntry single(String name, String relPath, int w, int h) {
        AssetEntry e = new AssetEntry();
        e.name = name;
        e.kind = AssetKind.IMAGE;
        e.path = relPath;
        e.width = w;
        e.height = h;
        return e;
    }

    /** 序列帧的"帧数"是它唯一必填的额外信息，其余由文件推断。 */
    public static AssetEntry sequence(String name, String folder, String head, int frames) {
        AssetEntry e = new AssetEntry();
        e.name = name;
        e.kind = AssetKind.SEQUENCE;
        e.path = folder;
        e.headName = head;
        e.frameCount = Math.max(1, frames);
        return e;
    }

    /** 图集：一张大图切格子，切法必须显式给出，不做猜测。 */
    public static AssetEntry atlas(String name, String relPath, int cols, int rows, int cell) {
        AssetEntry e = new AssetEntry();
        e.name = name;
        e.kind = AssetKind.ATLAS;
        e.path = relPath;
        e.cols = Math.max(1, cols);
        e.rows = Math.max(1, rows);
        e.cellW = cell;
        e.cellH = cell;
        return e;
    }

    public int totalFrames() {
        if (kind == AssetKind.SEQUENCE) {
            return Math.max(1, frameCount);
        }
        if (kind == AssetKind.ATLAS) {
            return Math.max(1, cols * rows);
        }
        return 1;
    }

    /** 序列帧的第 i 帧（0 基）实际文件名。 */
    public String frameFileName(int i) {
        int n = i + (zeroBased ? 0 : 1);
        return headName + n + ".png";
    }

    @Override
    public String toString() {
        return name == null || name.isEmpty() ? path : name;
    }
}
