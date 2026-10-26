package Studio.runtime;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.Clip;
import javax.sound.sampled.FloatControl;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 脚本音频（契约 §2.7，Phase 1 只保证 WAV）。
 *
 * <p>素材名走宿主的素材表（{@code data.assetByName} → Build 内相对路径），
 * 也可以直接给相对/绝对文件路径。任何失败（文件缺失、无声卡、格式不支持）
 * 都只写一条告警，绝不抛到游戏循环里。
 */
final class ScriptAudio {

    private final ScriptEngine engine;
    private final TopDownRuntime host;

    private final Map<Long, Clip> clips = new LinkedHashMap<Long, Clip>();
    private final Map<Long, String> clipNames = new LinkedHashMap<Long, String>();
    private final Set<String> warned = new HashSet<String>();
    private long nextId = 1;
    private float volume = 1f;
    private long musicId = -1;

    ScriptAudio(ScriptEngine engine) {
        this.engine = engine;
        this.host = engine.host;
    }

    // ---------------- 播放 ----------------

    long play(String name, float vol, boolean loop) {
        if (name == null || name.isEmpty()) {
            return -1;
        }
        File f = resolve(name);
        if (f == null) {
            warnOnce(name, "找不到音频素材「" + name + "」（Phase 1 只支持 WAV）");
            return -1;
        }
        try {
            AudioInputStream in = AudioSystem.getAudioInputStream(f);
            Clip clip = AudioSystem.getClip();
            clip.open(in);
            long id = nextId++;
            clips.put(Long.valueOf(id), clip);
            clipNames.put(Long.valueOf(id), name);
            applyVolume(clip, vol * volume);
            if (loop) {
                clip.loop(Clip.LOOP_CONTINUOUSLY);
            } else {
                clip.start();
            }
            return id;
        } catch (Throwable t) {
            warnOnce(name, "音频不可用「" + name + "」：" + t.getMessage());
            return -1;
        }
    }

    long music(String name, float vol, boolean loop) {
        if (musicId >= 0) {
            stop(musicId);
        }
        musicId = play(name, vol, loop);
        return musicId;
    }

    void stop(long id) {
        Clip clip = clips.remove(Long.valueOf(id));
        clipNames.remove(Long.valueOf(id));
        if (id == musicId) {
            musicId = -1;
        }
        if (clip == null) {
            return;
        }
        try {
            clip.stop();
            clip.close();
        } catch (Throwable ignored) {
        }
    }

    void stopByName(String name) {
        if (name == null) {
            return;
        }
        for (Map.Entry<Long, String> e : new ArrayList<Map.Entry<Long, String>>(clipNames.entrySet())) {
            if (name.equals(e.getValue())) {
                stop(e.getKey().longValue());
            }
        }
    }

    void setVolume(float v) {
        volume = Math.max(0f, Math.min(1f, v));
        for (Clip clip : new ArrayList<Clip>(clips.values())) {
            applyVolume(clip, volume);
        }
    }

    private void applyVolume(Clip clip, float v) {
        try {
            if (clip.isControlSupported(FloatControl.Type.MASTER_GAIN)) {
                FloatControl gain = (FloatControl) clip.getControl(FloatControl.Type.MASTER_GAIN);
                double db = 20.0 * Math.log10(Math.max(0.0001, Math.min(1.0, v)));
                float min = gain.getMinimum();
                float max = gain.getMaximum();
                gain.setValue((float) Math.max(min, Math.min(max, db)));
            }
        } catch (Throwable ignored) {
        }
    }

    // ---------------- 素材解析 ----------------

    private File resolve(String name) {
        try {
            GameData.RtAsset a = host.data.assetByName(name);
            if (a != null && a.path != null && !a.path.isEmpty()) {
                File f = new File(host.assetRoot, a.path);
                if (f.isFile()) {
                    return f;
                }
            }
            File direct = new File(host.assetRoot, name);
            if (direct.isFile()) {
                return direct;
            }
            File abs = new File(name);
            if (abs.isAbsolute() && abs.isFile()) {
                return abs;
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private void warnOnce(String key, String msg) {
        if (warned.add(key)) {
            engine.log(msg);
        }
    }

    /** 释放所有 clip（窗口关闭/引擎销毁时可选调用）。 */
    void dispose() {
        List<Long> ids = new ArrayList<Long>(clips.keySet());
        for (Long id : ids) {
            stop(id.longValue());
        }
    }
}
