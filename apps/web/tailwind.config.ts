import type { Config } from 'tailwindcss'

/** 设计令牌对齐 docs/03「全局 Shell」：深色顶栏 + 浅色内容区 + 蓝色主色 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        topbar: '#0d1117',
        canvas: '#f5f7fa',
        brand: {
          DEFAULT: '#2563eb',
          hover: '#1d4ed8',
        },
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
}

export default config
