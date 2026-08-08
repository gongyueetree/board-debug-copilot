# PyInstaller spec — 打成单文件可执行程序分发给最终用户
# 用法：pyinstaller bridge.spec

block_cipher = None

a = Analysis(
    ["src/main.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["matplotlib", "tkinter", "PIL"],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="bdc-bridge",
    debug=False,
    strip=False,
    upx=True,
    console=True,
)
