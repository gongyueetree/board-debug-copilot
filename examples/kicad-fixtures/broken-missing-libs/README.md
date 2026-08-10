# broken-missing-libs

故意坏掉的工程。**这个 fixture 通过的标准不是「解析成功」，而是「没崩、
parseLog 说清楚了发生什么」**（CLAUDE.md 硬性原则 #8）。

## 怎么造

先正常做一个能解析的工程，然后二选一：

- 删掉它引用的 `*.kicad_sym` 符号库文件
- 把 `sym-lib-table` / `fp-lib-table` 指向一个不存在的路径

## 验证什么

- `parseKicadArchive` 返回 `status` 而不是抛异常
- parseLog 里能读到具体是哪一步失败、失败原因是什么
- 项目不会被清空：解析不出组件时走降级分支，保留现有设计数据
