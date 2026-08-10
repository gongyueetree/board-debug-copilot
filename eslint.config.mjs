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
