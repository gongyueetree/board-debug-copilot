import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只跑纯单元测试。需要数据库或跑起服务的验证走 pnpm smoke / test:agent，
    // 混在一起会让 CI 里最快的那层也依赖 Postgres。
    include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
})
