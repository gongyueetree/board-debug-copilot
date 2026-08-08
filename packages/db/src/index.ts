/**
 * @app/db — Prisma client 单例
 *
 * 客户端由 `pnpm db:generate`（或本包 build）生成到默认位置。
 * 开发态复用全局实例，避免 HMR 反复建连接。
 */
import { PrismaClient } from '@prisma/client'

export * from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
