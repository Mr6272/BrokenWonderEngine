package Studio.data;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 路径换算。工程内一律使用"相对工程根的 '/' 分隔路径"，
 * 只有真正访问文件系统的那一刻才转成绝对路径。
 */
public final class PathUtil {

    private PathUtil() {
    }

    /** 绝对路径 → 相对工程根；不在工程内则退回文件名。 */
    public static String rel(File root, File f) {
        if (root == null || f == null) {
            return f == null ? "" : f.getName();
        }
        try {
            Path r = root.getAbsoluteFile().toPath().normalize();
            Path t = f.getAbsoluteFile().toPath().normalize();
            if (t.startsWith(r)) {
                return r.relativize(t).toString().replace('\\', '/');
            }
        } catch (Exception ignored) {
        }
        return f.getName();
    }

    public static File abs(File root, String rel) {
        if (rel == null || rel.isEmpty()) {
            return root;
        }
        return new File(root, rel.replace('/', File.separatorChar));
    }

    public static Path absPath(File root, String rel) {
        return Paths.get(abs(root, rel).getAbsolutePath());
    }

    public static String fileName(String rel) {
        if (rel == null) {
            return "";
        }
        int i = rel.lastIndexOf('/');
        return i < 0 ? rel : rel.substring(i + 1);
    }

    /** 去掉扩展名。 */
    public static String stem(String fileName) {
        if (fileName == null) {
            return "";
        }
        int i = fileName.lastIndexOf('.');
        return i <= 0 ? fileName : fileName.substring(0, i);
    }

    /** 去掉文件名末尾的连续数字，得到序列帧的公共前缀，如 "待机12" → "待机"。 */
    public static String stripTrailingDigits(String stem) {
        int end = stem.length();
        while (end > 0 && Character.isDigit(stem.charAt(end - 1))) {
            end--;
        }
        return stem.substring(0, end);
    }

    public static String pickExtension(File f) {
        String n = f.getName();
        int i = n.lastIndexOf('.');
        return i < 0 ? "" : n.substring(i + 1).toLowerCase();
    }

    public static boolean isImage(File f) {
        String e = pickExtension(f);
        return e.equals("png") || e.equals("jpg") || e.equals("jpeg") || e.equals("bmp") || e.equals("gif");
    }

    public static boolean isAudio(File f) {
        String e = pickExtension(f);
        return e.equals("wav") || e.equals("ogg") || e.equals("mp3") || e.equals("aiff") || e.equals("flac");
    }
}
