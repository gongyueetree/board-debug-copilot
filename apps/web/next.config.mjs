/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // docs/04：Vercel 上 Next.js 需把 packages/* 加入 transpilePackages
  transpilePackages: ['@app/ui', '@app/contracts', '@app/instrument-protocol'],
  eslint: {
    ignoreDuringBuilds: true,
  },
}

export default nextConfig
