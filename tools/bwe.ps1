# BWE local build / test / verify entry point (ASCII-only on purpose).
#
# Why this exists: this machine's default `java` is JDK 26, and JOGL 2.1 crashes hard
# on JDK 26 (JDK 26 removed java.applet -> NoClassDefFoundError: java/applet/Applet).
# Every Java build/run must explicitly use the JDK 25 install below.
#
# Usage:
#   .\tools\bwe.ps1 build               # compile all -> .tmp_build\bin
#   .\tools\bwe.ps1 test                # compile + run the 7 existing suites
#   .\tools\bwe.ps1 test-all            # 7 existing + every other *Test in Studio.runtime
#   .\tools\bwe.ps1 run <TestClass>     # run one class
#   .\tools\bwe.ps1 apidocs [-Strict]   # four-way API consistency
#   .\tools\bwe.ps1 typecheck           # tsc --noEmit
#   .\tools\bwe.ps1 offscreen <boot.json> <outPrefix> [frames] [w] [h]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Command,
    [Parameter(Position = 1)][string]$Arg1,
    [Parameter(Position = 2)][string]$Arg2,
    [Parameter(Position = 3)][string]$Arg3,
    [Parameter(Position = 4)][string]$Arg4,
    [Parameter(Position = 5)][string]$Arg5,
    [switch]$Strict
)

# Native tools (javac/java/node) write to stderr for notes and deprecation warnings even
# on success. With ErrorActionPreference=Stop PowerShell turns that into a terminating
# NativeCommandError. So keep Continue and always check $LASTEXITCODE explicitly.
$ErrorActionPreference = 'Continue'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$JdkHome = 'C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot'
$Javac = Join-Path $JdkHome 'bin\javac.exe'
$Java = Join-Path $JdkHome 'bin\java.exe'
$OutDir = Join-Path $RepoRoot '.tmp_build\bin'
$JvmFlags = @(
    '--enable-native-access=ALL-UNNAMED',
    '--add-opens=java.desktop/sun.awt=ALL-UNNAMED',
    '--add-opens=java.desktop/sun.java2d=ALL-UNNAMED'
)
$ExistingTests = @(
    'ScriptSelfTest', 'ScriptFieldsTest', 'ScriptPhysicsTest', 'ScriptAiTest',
    'ScriptPrefabTest', 'ScriptPerfTest', 'ScriptContractTest'
)

function Assert-Jdk {
    if (-not (Test-Path $Javac)) {
        throw "JDK 25 not found: $Javac . JOGL 2.1 cannot run on JDK 26, use JDK 17~25."
    }
}

function Invoke-Build {
    Assert-Jdk
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
    # Do NOT pre-delete every .class. With parallel agents sharing one build dir,
    # deleting classes while another agent is running tests yields bogus
    # ClassNotFoundException. javac overwrites incrementally; only sweep when the
    # class tree is clearly stale (source dir empty).
    $srcs = Get-ChildItem (Join-Path $RepoRoot 'src') -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
    $testSrcs = Get-ChildItem (Join-Path $RepoRoot 'test') -Recurse -Filter *.java -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    $all = @($srcs) + @($testSrcs)
    Push-Location $RepoRoot
    try {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $out = & $Javac -d $OutDir -encoding utf-8 -cp 'lib/*' @all 2>&1
        $code = $LASTEXITCODE
        $sw.Stop()
        if ($code -ne 0) {
            $out | Select-Object -First 60 | ForEach-Object { Write-Host $_ -ForegroundColor Red }
            throw "BUILD FAILED exit=$code files=$($all.Count)"
        }
        Write-Host ("BUILD OK  files={0}  {1:N2}s" -f $all.Count, $sw.Elapsed.TotalSeconds)
    } finally {
        Pop-Location
    }
}

function Invoke-TestClass([string]$name) {
    Push-Location $RepoRoot
    try {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $out = & $Java @JvmFlags '-cp' "$OutDir;lib/*" "Studio.runtime.$name" 2>&1
        $code = $LASTEXITCODE
        $sw.Stop()
        $summary = ($out | Where-Object { $_ -match 'ALL PASS|FAILED' } | Select-Object -Last 1)
        if ($code -eq 0) {
            Write-Host ("  [PASS] {0,-22} {1,6:N2}s  {2}" -f $name, $sw.Elapsed.TotalSeconds, $summary) -ForegroundColor Green
        } else {
            Write-Host ("  [FAIL] {0,-22} exit={1}" -f $name, $code) -ForegroundColor Red
            $out | Select-Object -Last 40 | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor Red }
        }
        return $code
    } finally {
        Pop-Location
    }
}

function Invoke-Tests([switch]$All) {
    $names = $ExistingTests
    if ($All) {
        $extra = Get-ChildItem (Join-Path $RepoRoot 'src\Studio\runtime') -Filter '*Test.java' -ErrorAction SilentlyContinue |
            ForEach-Object { $_.BaseName } |
            Where-Object { $ExistingTests -notcontains $_ } |
            Sort-Object
        $names = $ExistingTests + $extra
    }
    Write-Host "==== TESTS ($($names.Count) suites) ===="
    $fail = 0
    foreach ($n in $names) {
        if ((Invoke-TestClass $n) -ne 0) { $fail++ }
    }
    $color = 'Green'
    if ($fail -gt 0) { $color = 'Red' }
    Write-Host "==== RESULT: $($names.Count - $fail)/$($names.Count) passed ====" -ForegroundColor $color
    if ($fail -gt 0) {
        Write-Host "$fail suite(s) failed" -ForegroundColor Red
        exit 1
    }
}

function Invoke-RunClass([string]$cls) {
    $full = $cls
    if ($cls -notlike 'Studio.runtime.*') { $full = "Studio.runtime.$cls" }
    Push-Location $RepoRoot
    try { & $Java @JvmFlags '-cp' "$OutDir;lib/*" $full }
    finally { Pop-Location }
}

function Invoke-ApiDocs {
    Push-Location $RepoRoot
    try {
        if ($Strict.IsPresent) {
            node web/tools/verify-apidocs.mjs --strict
        } else {
            node web/tools/verify-apidocs.mjs
        }
        if ($LASTEXITCODE -ne 0) { throw "API four-way check failed exit=$LASTEXITCODE" }
    } finally { Pop-Location }
}

function Invoke-Typecheck {
    Push-Location $RepoRoot
    try {
        node node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json
        if ($LASTEXITCODE -ne 0) { throw "tsc failed exit=$LASTEXITCODE" }
        Write-Host 'TYPECHECK OK'
    } finally { Pop-Location }
}

function Invoke-Offscreen([string]$boot, [string]$prefix) {
    $frames = 30
    $w = 960
    $h = 540
    if ($Arg3) { $frames = [int]$Arg3 }
    if ($Arg4) { $w = [int]$Arg4 }
    if ($Arg5) { $h = [int]$Arg5 }
    Push-Location $RepoRoot
    try {
        & $Java @JvmFlags '-cp' "$OutDir;lib/*" '-Djava.library.path=lib' `
            'Studio.runtime.OffscreenFrameDump' $boot $prefix $frames $w $h
        if ($LASTEXITCODE -ne 0) { throw "offscreen render failed exit=$LASTEXITCODE" }
    } finally { Pop-Location }
}

function Resolve-GradleJdk {
    # Gradle 7.5.1 bundles Groovy 3.0.10, which cannot read JDK 20+ class files
    # (Unsupported class file major version 69). Restrict to JDK 8~19.
    $roots = @('C:\Program Files\Microsoft','C:\Program Files\Java',
               'C:\Program Files\Eclipse Adoptium', 'D:\UnityAndroid\OpenJDK')
    $found = @()
    foreach ($r in $roots) {
        if (-not (Test-Path $r)) { continue }
        if (Test-Path (Join-Path $r 'bin\java.exe')) { $found += (Get-Item $r).FullName; continue }
        foreach ($d in Get-ChildItem $r -Directory -ErrorAction SilentlyContinue) {
            if (Test-Path (Join-Path $d.FullName 'bin\java.exe')) { $found += $d.FullName }
        }
    }
    $usable = @()
    foreach ($home_ in $found) {
        $exe = Join-Path $home_ 'bin\java.exe'
        try { $ver = (& $exe -version 2>&1 | Select-Object -First 1) -join '' } catch { continue }
        if ($ver -match 'version "(\d+)') {
            $major = [int]$Matches[1]
            if ($major -ge 11 -and $major -le 19) {
                $usable += [pscustomobject]@{ Home = $home_; Major = $major }
            }
        }
    }
    if ($usable.Count -eq 0) { return $null }
    return ($usable | Sort-Object Major -Descending | Select-Object -First 1).Home
}

function Invoke-Android {
    param([string]$Variant = 'release')
    $androidRoot = Join-Path $RepoRoot 'android'
    $gradlew = Join-Path $androidRoot 'gradlew.bat'
    if (-not (Test-Path $gradlew)) {
        throw "Android gradle wrapper missing: $gradlew (run 'gradle wrapper' in android/ once)."
    }
    $jdkHome = Resolve-GradleJdk
    if (-not $jdkHome) { throw 'No usable JDK found for Gradle (need JDK 11~19; AGP 7.4.2 needs 11+, Groovy 3.0.10 caps at 19).' }
    Write-Host "Android build with JAVA_HOME=$jdkHome (variant=$Variant)"
    $env:JAVA_HOME = $jdkHome
    $task = 'assembleRelease'
    if ($Variant -eq 'debug') { $task = 'assembleDebug' }
    Push-Location $androidRoot
    try {
        & $gradlew $task --no-daemon
        if ($LASTEXITCODE -ne 0) { throw "gradlew $task failed exit=$LASTEXITCODE" }
        $apkRel = 'app\build\outputs\apk\release\app-release.apk'
        if ($Variant -eq 'debug') { $apkRel = 'app\build\outputs\apk\debug\app-debug.apk' }
        $apk = Join-Path $androidRoot $apkRel
        if (-not (Test-Path $apk)) { throw "APK not produced: $apk" }
        $size = (Get-Item $apk).Length
        $hasKey = (Test-Path (Join-Path $androidRoot 'signing.properties')) -or
                  (Test-Path (Join-Path $androidRoot 'bwe-release.jks')) -or
                  [bool]$env:BWE_KEYSTORE
        $note = ''
        if ($Variant -eq 'release' -and -not $hasKey) { $note = '  [TEST PACKAGE: falls back to debug signing]' }
        Write-Host ('APK OK  {0}  {1:N1} MB{2}' -f $apk, ($size / 1MB), $note) -ForegroundColor Green
    } finally { Pop-Location }
}

switch ($Command.ToLower()) {
    'build' { Invoke-Build }
    'test' { Invoke-Build; Invoke-Tests }
    'test-all' { Invoke-Build; Invoke-Tests -All }
    'run' { Invoke-Build; Invoke-RunClass $Arg1 }
    'apidocs' { Invoke-ApiDocs }
    'typecheck' { Invoke-Typecheck }
    'offscreen' { Invoke-Build; Invoke-Offscreen $Arg1 $Arg2 }
    'android' { Invoke-Android $(if ($Arg1) { $Arg1 } else { 'release' }) }
    default {
        Write-Host "Unknown command: $Command"
        Write-Host 'Available: build | test | test-all | run <Class> | apidocs [-Strict] | typecheck | offscreen <boot> <prefix> [frames] [w] [h] | android'
        exit 2
    }
}
