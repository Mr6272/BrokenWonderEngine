package TypeStructure;

import Tool.ImgLoader;
import com.jogamp.opengl.util.texture.Texture;

import java.io.IOException;
import java.util.UUID;

public class Sprite {
    public String id;
    public boolean isAwake = true;
    public int texture;
    public int[] textures;
    public ImgLoader ils = new ImgLoader();
    /// 类型
    public SpriteType SpType;
    /// 精灵平铺模式
    public SpriteWrapMode SwMode;
    //以下是single特性。
    /// 单精灵-路径
    public String single_filePath;
    public String single_name;
    //以下是multi特性
    /// 精灵所在的文件夹路径
    public String multiple_floderPath;
    /// 精灵的头名称。多帧精灵命名规则: 头名称1、头名称2 ...
    public String multiple_fileHeadName;
    /// 精灵图片读取的终止序号，注意：从0开始的。
    public int multiple_endCount;
    public SpriteAtlas Atlas;

    /// 单精灵图 参数1平铺类型。参数2精灵
    public Sprite(SpriteWrapMode swm, String sf, String single_name)
    {
        id = UUID.randomUUID().toString();
        SpType = SpriteType.Single;
        SwMode = swm;
        single_filePath = sf;
        this.single_name = single_name;
    }

    /// 多精灵图 参数2图片文件夹路径，参数3图片头部名字。参数4图片终止下标
    public Sprite(SpriteWrapMode swm, String mf, String mfhn, int mec)
    {
        id = UUID.randomUUID().toString();
        SpType = SpriteType.Multiple;
        SwMode = swm;
        multiple_floderPath = mf;
        multiple_fileHeadName = mfhn;
        multiple_endCount = mec;
    }

    public Sprite(SpriteWrapMode swm, SpriteAtlas atlas)
    {
        id = UUID.randomUUID().toString();
        SpType = SpriteType.Atlas;
        SwMode = swm;
        Atlas = atlas;
    }
}
