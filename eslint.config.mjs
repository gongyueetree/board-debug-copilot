import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/.venv/**',
      // Next 生成，改了也会被覆盖
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 纯 JS 的 Node 脚本。TS 文件不需要这段（typescript-eslint 关掉了 no-undef，
    // 全局符号交给 @types/node 判定），只有 .mjs/.js 会撞上。
    // 不引 globals 包：这里只用到这几个，列出来比多一个依赖清楚。
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
  },
  {
    rules: {
      // 项目里大量用 `as never` 绕开 Prisma 的 Json 类型，这是有意为之
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // 下划线开头表示"知道没用到"
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 空 catch 用来做"失败不影响主流程"的降级，是刻意的
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
