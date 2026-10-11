package Studio.data;

/** 素材种类。导入方式与运行期用法都由它决定。 */
public enum AssetKind {

    /** 单张图片：一个物件、一块地面。 */
    IMAGE("单张图"),
    /** 序列帧：文件夹里 待机1.png 待机2.png … 依次播放成动画。 */
    SEQUENCE("序列帧"),
    /** 图集：一张大图切成 N 行 M 列，按帧号取用。 */
    ATLAS("图集"),
    /** 音频：音效或音乐。 */
    AUDIO("音频"),
    /** 音效短促播放，音频长循环播放。 */
    UNKNOWN("未知");

    public final String cn;

    AssetKind(String cn) {
        this.cn = cn;
    }

    @Override
    public String toString() {
        return cn;
    }
}
