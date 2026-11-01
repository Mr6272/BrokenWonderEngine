package Studio.runtime;

/**
 * GL 纹理句柄：id 与像素尺寸。
 *
 * <p>尺寸参与「对象绘制多大」的计算（{@code drawWidth/Height}），所以必须和 id 一起存。
 * 提升为包级类，使玩法模块（如扫雷棋盘）能独立引用。
 */
final class Texture {
    int id;
    int w;
    int h;
    }