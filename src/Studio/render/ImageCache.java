package Studio.render;

import Studio.data.AssetEntry;
import Studio.data.AssetKind;
import Studio.data.PathUtil;

import javax.imageio.ImageIO;
import java.awt.Image;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * 二维图像缓存（编辑器侧）。
 *
 * 与引擎侧 TextureCache 的区别：那一个管 GPU 纹理，这一个管 AWT 图像。
 * 编辑器没有 GL 上下文，所有素材预览都走这里。
 *
 * 三条纪律：
 * 1. 同一路径只读一次磁盘；
 * 2. 找不到文件不能抛错打断绘制 —— 返回 null，让画布画占位框；
 * 3. 缩略图单独缓存（列表里几百张原图直接缩放会卡）。
 */
public final class ImageCache {

    private static final Map<String, Image> FULL = new HashMap<>();
    private static final Map<String, Image> THUMB = new HashMap<>();
    private static final Map<String, Boolean> MISSING = new HashMap<>();

    private ImageCache() {
    }

    /** 读原图；失败返回 null。 */
    public static Image load(File root, String relPath) {
        if (relPath == null || relPath.isEmpty()) {
            return null;
        }
        String key = relPath;
        if (FULL.containsKey(key)) {
            return FULL.get(key);
        }
        if (Boolean.TRUE.equals(MISSING.get(key))) {
            return null;
        }
        File f = PathUtil.abs(root, relPath);
        if (!f.isFile()) {
            MISSING.put(key, true);
            return null;
        }
        try {
            BufferedImage img = ImageIO.read(f);
            if (img == null) {
                MISSING.put(key, true);
                return null;
            }
            FULL.put(key, img);
            return img;
        } catch (Exception e) {
            MISSING.put(key, true);
            return null;
        }
    }

    /** 取素材的某一帧（单图 / 序列帧 / 图集统一入口）。 */
    public static Image frame(File root, AssetEntry e, int frameIndex) {
        if (e == null) {
            return null;
        }
        switch (e.kind) {
            case IMAGE:
            case AUDIO:
                return load(root, e.path);
            case SEQUENCE: {
                int n = Math.max(0, Math.min(e.frameCount - 1, frameIndex));
                return load(root, e.path + "/" + e.frameFileName(n));
            }
            case ATLAS: {
                Image whole = load(root, e.path);
                if (whole == null) {
                    return null;
                }
                int cw = e.cellW > 0 ? e.cellW : (e.width > 0 ? e.width / Math.max(1, e.cols) : 0);
                int ch = e.cellH > 0 ? e.cellH : (e.height > 0 ? e.height / Math.max(1, e.rows) : 0);
                if (cw <= 0 || ch <= 0) {
                    return whole;
                }
                int i = Math.max(0, Math.min(e.totalFrames() - 1, frameIndex));
                int col = i % Math.max(1, e.cols);
                int row = i / Math.max(1, e.cols);
                try {
                    return ((BufferedImage) whole).getSubimage(col * cw, row * ch, cw, ch);
                } catch (Exception ex) {
                    return whole;
                }
            }
            default:
                return null;
        }
    }

    /** 缩略图（素材列表用）。 */
    public static Image thumb(File root, AssetEntry e, int size) {
        if (e == null) {
            return null;
        }
        String key = e.id + "@" + size;
        if (THUMB.containsKey(key)) {
            return THUMB.get(key);
        }
        Image src = frame(root, e, 0);
        if (src == null) {
            return null;
        }
        int w = src.getWidth(null);
        int h = src.getHeight(null);
        if (w <= 0 || h <= 0) {
            return null;
        }
        double k = Math.min(size / (double) w, size / (double) h);
        int tw = Math.max(1, (int) Math.round(w * k));
        int th = Math.max(1, (int) Math.round(h * k));
        BufferedImage out = new BufferedImage(tw, th, BufferedImage.TYPE_INT_ARGB);
        var g = out.createGraphics();
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(src, 0, 0, tw, th, null);
        g.dispose();
        THUMB.put(key, out);
        return out;
    }

    /** 素材路径失效后清缓存（重新导入或换工程时调用）。 */
    public static void clear() {
        FULL.clear();
        THUMB.clear();
        MISSING.clear();
    }

    public static void invalidate(String relPath) {
        FULL.remove(relPath);
        MISSING.remove(relPath);
        THUMB.keySet().removeIf(k -> k.startsWith(relPath));
    }
}
