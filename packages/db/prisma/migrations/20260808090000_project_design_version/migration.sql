-- Project 增加设计版本号。
-- 每次成功解析 KiCad 工程 +1；捕获保存时记录当时的版本，
-- 与当前版本不一致时 UI 提示「来自旧设计版本」。
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "designVersion" INTEGER NOT NULL DEFAULT 1;
