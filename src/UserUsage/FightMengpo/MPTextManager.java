package UserUsage.FightMengpo;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

import com.google.gson.Gson;

import Framework.GameObject;
import Tool.Log;
import UserUsage.FightMengpo.Data.ExcelData;
import java.util.List;

public class MPTextManager extends GameObject {
    List<ExcelData> text;
    Gson gson = new Gson();
    public MPTextManager(String path) {
        super();
        try {
            Reader reader = new InputStreamReader(Files.newInputStream(Paths.get(path)), StandardCharsets.UTF_8);
            text = gson.fromJson(reader, new com.google.gson.reflect.TypeToken<List<ExcelData>>(){}.getType());
        } catch (IOException e) {
            e.printStackTrace();
        }
        for (ExcelData ed : text) {
            Log.d(ed.Talk);
        }
    }
    
    @Override
    public void Update() {
        super.Update();
        if (isEnabled == false) {
            return;
        }

    }
}
