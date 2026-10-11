package Studio.app;

import Studio.data.AssetEntry;
import Studio.data.AssetKind;
import Studio.data.AssetLibrary;
import Studio.data.PathUtil;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 素材导入。
 *
 * 两种导入方式（用户要的"逐张导入"和"序列帧导入"）：
 * 1. 逐张：选若干图片/音频文件，一张一条素材；
 * 2. 序列帧：选一个文件夹，把 名字1.png 名字2.png … 自动归成一条会动的素材。
 *
 * 设计纪律：
 * - 文件夹里如果同时存在多组帧（待机1、待机2 与 跑步1、跑步2），要自动分成多条，
 *   而不是硬塞成一条 —— 这是最容易出错的地方，必须按名字前缀分组。
 * - 文件数量变化时重新计算帧数，不做"猜"。
 * - 绝不移动或复制用户的原始文件，只记录路径。
 */
public final class AssetImport {

    /** 导入结果，用于给用户一句准确的反馈。 */
    public static final class Result {
        public int added;
        public int skipped;
        public String message = "";
    }

    private AssetImport() {
    }

    /** 逐张导入。 */
    public static Result importFiles(AppState st, File[] files) {
        Result r = new Result();
        if (files == null || files.length == 0) {
            return r;
        }
        File root = projectRoot(st);
        AssetLibrary lib = st.project().assets;
        for (File f : files) {
            if (f == null || !f.isFile()) {
                continue;
            }
            boolean img = PathUtil.isImage(f);
            boolean aud = PathUtil.isAudio(f);
            if (!img && !aud) {
                r.skipped++;
                continue;
            }
            String rel = PathUtil.rel(root, f);
            if (lib.findByPath(rel) != null) {
                r.skipped++;
                continue;
            }
            AssetEntry e;
            if (aud) {
                e = new AssetEntry();
                e.name = PathUtil.stem(f.getName());
                e.kind = AssetKind.AUDIO;
                e.path = rel;
                e.group = "音频";
            } else {
                e = AssetEntry.single(PathUtil.stem(f.getName()), rel, 0, 0);
                e.group = f.getParentFile() != null && f.getParentFile().equals(root)
                        ? "未分组" : PathUtil.fileName(PathUtil.rel(root, f.getParentFile()));
            }
            lib.add(e);
            r.added++;
        }
        if (r.added == 0) {
            r.message = "选中的文件里没有能用的图片或音频";
        }
        return r;
    }

    /**
     * 序列帧导入：扫描文件夹，按"去掉尾部数字后的名字"分组，每组一条序列帧素材。
     */
    public static Result importSequenceFolder(AppState st, File dir) {
        Result r = new Result();
        if (dir == null || !dir.isDirectory()) {
            return r;
        }
        File root = projectRoot(st);
        AssetLibrary lib = st.project().assets;

        Map<String, List<File>> groups = new TreeMap<>();
        File[] children = dir.listFiles();
        if (children == null) {
            r.message = "读不到这个文件夹";
            return r;
        }
        for (File f : children) {
            if (f.isFile() && PathUtil.isImage(f)) {
                String prefix = PathUtil.stripTrailingDigits(PathUtil.stem(f.getName()));
                groups.computeIfAbsent(prefix, k -> new ArrayList<>()).add(f);
            }
        }
        if (groups.isEmpty()) {
            r.message = "这个文件夹里没有图片";
            return r;
        }

        String relDir = PathUtil.rel(root, dir);
        String groupName = dir.getName();
        for (Map.Entry<String, List<File>> en : groups.entrySet()) {
            List<File> fs = en.getValue();
            fs.sort((a, b) -> a.getName().compareToIgnoreCase(b.getName()));
            if (fs.size() == 1) {
                // 只有一帧：按单图导入，不必造一个长度为 1 的"动画"
                String rel = PathUtil.rel(root, fs.get(0));
                if (lib.findByPath(rel) != null) {
                    r.skipped++;
                    continue;
                }
                AssetEntry e = AssetEntry.single(PathUtil.stem(fs.get(0).getName()), rel, 0, 0);
                e.group = groupName;
                lib.add(e);
                r.added++;
                continue;
            }
            String head = en.getKey();
            String probe = PathUtil.rel(root, fs.get(0));
            if (lib.findByPath(probe) != null) {
                r.skipped++;
                continue;
            }
            // 判断编号从 0 还是 1 开始
            boolean zeroBased = fs.get(0).getName().startsWith(head + "0");
            AssetEntry e = AssetEntry.sequence(head.isEmpty() ? groupName : head, relDir, head, fs.size());
            e.zeroBased = zeroBased;
            e.group = groupName;
            lib.add(e);
            r.added++;
        }
        if (r.added == 0 && r.skipped == 0) {
            r.message = "没有识别到可导入的图";
        }
        return r;
    }

    /** 图集切片导入：一张图按行列切。 */
    public static Result importAtlas(AppState st, File file, int cols, int rows, int cell) {
        Result r = new Result();
        File root = projectRoot(st);
        String rel = PathUtil.rel(root, file);
        AssetEntry e = AssetEntry.atlas(PathUtil.stem(file.getName()), rel, cols, rows, cell);
        e.group = "图集";
        st.project().assets.add(e);
        r.added = 1;
        return r;
    }

    /** 工程根：优先工程文件所在目录，未保存则用当前工作目录。 */
    public static File projectRoot(AppState st) {
        File f = st.projectFile();
        if (f != null && f.getParentFile() != null) {
            return f.getParentFile();
        }
        return new File(System.getProperty("user.dir"));
    }

    /** 统计同名组，用于把它拆成多条素材（供图集导入界面预览用）。 */
    public static Map<String, Integer> scanGroups(File dir) {
        Map<String, Integer> out = new HashMap<>();
        File[] children = dir == null ? null : dir.listFiles();
        if (children == null) {
            return out;
        }
        for (File f : children) {
            if (f.isFile() && PathUtil.isImage(f)) {
                String prefix = PathUtil.stripTrailingDigits(PathUtil.stem(f.getName()));
                out.merge(prefix, 1, Integer::sum);
            }
        }
        return out;
    }
}
