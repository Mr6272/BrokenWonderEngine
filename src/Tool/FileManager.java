package Tool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;

// 文件管理器类，负责文件 I/O
public class FileManager {
    public static byte[] loadFile(String filePath) {
        try {
            return Files.readAllBytes(Paths.get(filePath));
        } catch (IOException e) {
            e.printStackTrace();
            return null;
        }
    }
}