package UserUsage.xia_demo;

import Core.GameSekai;
import Core.Scene;
import Core.Vector2;
import Core.SceneManageTool.SceneObjReg;
import Framework.*;
import Framework.MapData.MapData;
import Framework.MapData.MapObjectData;

/*
 * 地图应该是可以被泛用和重用的。
 * 感觉应该是容纳各种GO的容器
 * */
public class Map extends Scene {

    public Map(String path)
    {
        super(path);
    }

    @Override
    public void build(GameSekai scene, MapData data) {
        float cellSize = data.cellSize;

        // 先建地块
        for (int y = 0; y < data.height; y++) {
            for (int x = 0; x < data.width; x++) {
                float worldX = x * cellSize;
                float worldY = y * cellSize;

                if (y == data.height - 1 || y == 0 || x == 0 || x == data.width - 1) {
                    createWall(scene, worldX, worldY);
                } else {
                    createFloor(scene, worldX, worldY);
                }
            }
        }
        SceneObjReg.register("player", (s, obj) -> {
            createPlayer(scene, obj.x, obj.y, obj.z, obj.rotation, obj);
        });
        SceneObjReg.register("box", (s, obj) -> {
            createBox(scene, obj.x, obj.y, obj.z, obj.rotation, obj);
        });
        SceneObjReg.register("room1inside", (s, obj) -> {
            createroom1inside(s, obj.x, obj.y, new Vector2(obj.scaleX, obj.scaleY), obj.z, obj.rotation, obj);
        });
        SceneObjReg.register("room1outside", (s, obj) -> {
            createoom1outside(s, obj.x, obj.y, obj.z, new Vector2(obj.scaleX, obj.scaleY), obj.rotation, obj);
        });

        super.build(scene, data);
    }

    private static void createoom1outside(GameSekai scene, float worldX, float worldY, float z, Vector2 scale, float rotation, MapObjectData obj) {
        room1outside box = new room1outside();
        box.transform.position.x = worldX;
        box.transform.position.y = worldY;
        box.transform.scale = scale;
        box.renderer.order = z;
        box.transform.rotation = rotation;
        BoxColliderAbility BCA = new BoxColliderAbility();
        BCA.halfWidth = box.transform.scale.x / 4 / 4 / 2;
        BCA.halfHeight = box.transform.scale.y / 4/ 4 / 2;
        BCA.isFrozen = true;
        box.AddAbility(BCA);
    }

    private static void createroom1inside(GameSekai scene, float worldX, float worldY, Vector2 scale, float z, float rotation, MapObjectData obj) {
        room1inside box = new room1inside();
        box.transform.position.x = worldX;
        box.transform.position.y = worldY;
        box.renderer.order = z;
        box.transform.rotation = rotation;
        box.transform.scale = scale;
    }

    private static void createFloor(GameSekai scene, float worldX, float worldY) {
        Floor box = new Floor();
        box.transform.position.x = worldX;
        box.transform.position.y = worldY;
        box.renderer.order = -0.9f;
    }

    private static void createWall(GameSekai scene, float worldX, float worldY) {
        WoodBox box = new WoodBox();
        box.transform.position.x = worldX;
        box.transform.position.y = worldY;
    }

    private static void createBox(GameSekai scene, float worldX, float worldY, float z, float rotation, MapObjectData obj) {
        WoodBox box = new WoodBox();
        box.transform.position.x = worldX;
        box.transform.position.y = worldY;
        box.renderer.order = z;
        box.transform.rotation = rotation;
    }

    private static void createPlayer(GameSekai scene, float worldX, float worldY, float z, float rotation, MapObjectData obj) {
        Xia xia = new Xia();
        xia.transform.position.x = worldX;
        xia.transform.position.y = worldY;
        xia.renderer.order = z;
        xia.transform.rotation = rotation;
        GameObject go = new GameObject();
        CameraAbility cm = new CameraAbility(xia.transform);
        cm.isFollowPlayer = true;
        go.AddAbility(cm);
    }
}
