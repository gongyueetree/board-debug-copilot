import { PrismaClient } from '@app/db'

/**
 * Processor 共享上下文。
 *
 * worker 直接用 PrismaClient 而不是 NestJS DI —— 它不是 Nest 应用，
 * 引整套容器只为拿一个 client 不值得。
 */
export interface JobContext {
  prisma: PrismaClient
  log: (msg: string) => void
}

let client: PrismaClient | null = null

export function prisma(): PrismaClient {
  client ??= new PrismaClient({ log: ['error'] })
  return client
}

export async function disconnect(): Promise<void> {
  await client?.$disconnect()
  client = null
}
