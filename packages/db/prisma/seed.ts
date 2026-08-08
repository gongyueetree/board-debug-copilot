/**
 * Seed — Sensor Board Debug Demo
 *
 * P1 落地全量 Demo 数据，规格见 docs/02「Seed（必须实现）」与 docs/05 §11.1（五场景数值）。
 * P0 阶段只保证脚本可运行、能建出项目本体，不阻塞骨架验收。
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const project = await prisma.project.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000d1' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000d1',
      name: 'Sensor Board Debug Demo',
      description: 'AD8605 反相放大器（单电源 5V）+ MCP4725 DAC + TPS7A02 LDO',
      status: 'READY',
      currentIssue: '输出无响应，Vout 一直为 0V',
    },
  })

  console.log(`seeded project ${project.id} (${project.name})`)
  console.log('P1 将在此补全组件/网络/违规/捕获/调试计划/视觉发现/报告')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
