package Framework;

// MapLoader.java
import Framework.MapData.MapData;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;

public class MapLoader {

    private static final Gson gson = new GsonBuilder()
            .setPrettyPrinting()
            .create();

    /**
     * 从磁盘上的 json 文件解析 MapData
     * @param path 文件路径，比如 "assets/maps/level1.json"
     */
    public static MapData loadFromJsonFile(String path) throws IOException {
        try (Reader reader = new InputStreamReader(
                Files.newInputStream(Paths.get(path)),
                StandardCharsets.UTF_8)) {

            return gson.fromJson(reader, MapData.class);
        }
    }

    /**
     * 如果你是从字符串里读（比如网络 / 内存中）
     */
    public static MapData loadFromJsonString(String json) {
        return gson.fromJson(json, MapData.class);
    }
}

