package Core;

import AbstractLayer.MainWindow;
import Core.SceneManageTool.SceneObjReg;
import Framework.MapData.MapData;
import Framework.MapData.MapObjectData;
import Framework.MapLoader;

import java.io.IOException;

public class Scene {
    protected MapData data;

    public Scene(String path)
    {
        // 构造时即加载关卡数据；genMap 只负责实例化对象
        try {
            data = MapLoader.loadFromJsonFile(path);
        } catch (IOException e) {
            e.printStackTrace();
        }
        MainWindow.scene = () -> {
            build(GameRenderer.sekai, data);
        };
    }

    public void build(GameSekai scene, MapData data)
    {
        if (data == null || data.objects == null) {
            return;
        }
        for (MapObjectData obj : data.objects) {
            SceneObjReg.createObject(obj.type, scene, obj);
        }
    }
}
