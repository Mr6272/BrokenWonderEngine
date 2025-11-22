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
        MainWindow.scene = () -> {
            try {
                data = MapLoader.loadFromJsonFile(path);
                build(GameRenderer.sekai, data);
            } catch (IOException e) {
                e.printStackTrace();
            }
        };
    }

    public void build(GameSekai scene, MapData data)
    {
        for (MapObjectData obj : data.objects) {
            SceneObjReg.createObject(obj.type, scene, obj);
        }   
    }
}
