import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { SessionUser } from '../auth/auth.service'
import { PrismaService } from '../prisma/prisma.service'

/**
 * 克隆项目。
 *
 * 公共 Demo 只读，想动手就克隆一份到自己名下。复制的是「设计与调试上下文」：
 * 组件、网络、测试点、违规、调试计划、照片元数据与视觉发现。
 *
 * 不复制波形对象：那是几十 MB 的原始数组，克隆一份 demo 不该顺带复制它们。
 * 捕获的摘要会带过来，波形引用指向原对象（demo asset 是只读共享的）。
 */
@Injectable()
export class CloneService {
  constructor(private readonly prisma: PrismaService) {}

  async clone(sourceId: string, user: SessionUser | null, name?: string) {
    if (!user) {
      throw new ForbiddenException('克隆需要先登录。POST /api/v1/auth/login 用邮箱即可创建账号。')
    }

    const src = await this.prisma.project.findUnique({
      where: { id: sourceId },
      include: {
        components: { include: { pins: true } },
        nets: true,
        testPoints: true,
        violations: true,
        debugSteps: true,
        captures: true,
        photos: { include: { visualFindings: true, annotations: true } },
      },
    })
    if (!src) throw new NotFoundException(`项目不存在: ${sourceId}`)

    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          userId: user.id,
          name: name ?? `${src.name}（我的副本）`,
          description: src.description,
          status: src.status,
          currentIssue: src.currentIssue,
          designVersion: src.designVersion,
        },
      })

      // 网络先建：引脚要引用它们
      const netId = new Map<string, string>()
      for (const n of src.nets) {
        const created = await tx.net.create({
          data: {
            projectId: project.id,
            name: n.name,
            netClass: n.netClass,
            inferredRole: n.inferredRole,
            expectedVoltage: n.expectedVoltage,
            expectedFrequency: n.expectedFrequency,
            rawJson: n.rawJson ?? undefined,
          },
        })
        netId.set(n.id, created.id)
      }

      const compId = new Map<string, string>()
      for (const c of src.components) {
        const created = await tx.component.create({
          data: {
            projectId: project.id,
            ref: c.ref,
            value: c.value,
            symbol: c.symbol,
            footprint: c.footprint,
            partNumber: c.partNumber,
            manufacturer: c.manufacturer,
            datasheetUrl: c.datasheetUrl,
            x: c.x,
            y: c.y,
            rotation: c.rotation,
            side: c.side,
            rawJson: c.rawJson ?? undefined,
          },
        })
        compId.set(c.id, created.id)
        for (const p of c.pins) {
          await tx.pin.create({
            data: {
              componentId: created.id,
              number: p.number,
              name: p.name,
              type: p.type,
              netId: p.netId ? (netId.get(p.netId) ?? null) : null,
            },
          })
        }
      }

      for (const t of src.testPoints) {
        await tx.testPoint.create({
          data: {
            projectId: project.id,
            componentId: t.componentId ? (compId.get(t.componentId) ?? null) : null,
            netId: t.netId ? (netId.get(t.netId) ?? null) : null,
            label: t.label,
            description: t.description,
            x: t.x,
            y: t.y,
            source: t.source,
          },
        })
      }

      if (src.violations.length > 0) {
        await tx.ruleViolation.createMany({
          data: src.violations.map((v) => ({
            projectId: project.id,
            origin: v.origin,
            code: v.code,
            severity: v.severity,
            title: v.title,
            description: v.description,
            evidence: v.evidence,
            risk: v.risk,
            suggestion: v.suggestion,
            recommendedTest: v.recommendedTest,
            componentRef: v.componentRef,
            netName: v.netName,
            resolved: v.resolved,
          })),
        })
      }

      // 调试步骤是两层树，父节点先建
      const stepId = new Map<string, string>()
      for (const s of src.debugSteps.filter((x) => x.parentId === null)) {
        const created = await tx.debugStep.create({
          data: {
            projectId: project.id,
            order: s.order,
            title: s.title,
            status: s.status,
          },
        })
        stepId.set(s.id, created.id)
      }
      for (const s of src.debugSteps.filter((x) => x.parentId !== null)) {
        const created = await tx.debugStep.create({
          data: {
            projectId: project.id,
            parentId: s.parentId ? (stepId.get(s.parentId) ?? null) : null,
            order: s.order,
            title: s.title,
            objective: s.objective,
            toolHint: s.toolHint,
            estimateMin: s.estimateMin,
            setupJson: s.setupJson ?? undefined,
            targetNet: s.targetNet,
            targetComponent: s.targetComponent,
            expectedResult: s.expectedResult,
            abnormalNext: s.abnormalNext,
            status: s.status,
            resultJson: s.resultJson ?? undefined,
          },
        })
        stepId.set(s.id, created.id)
      }

      // 捕获只复制摘要。waveformObjectKey 指向原对象：几十 MB 的原始数组
      // 不该因为克隆一份 demo 就复制一遍。
      for (const c of src.captures) {
        await tx.capture.create({
          data: {
            projectId: project.id,
            netId: c.netId ? (netId.get(c.netId) ?? null) : null,
            kind: c.kind,
            label: c.label,
            hardwareSetupJson: c.hardwareSetupJson ?? {},
            measurementsJson: c.measurementsJson ?? {},
            waveformObjectKey: c.waveformObjectKey,
            thumbnailObjectKey: c.thumbnailObjectKey,
            debugStepId: c.debugStepId ? (stepId.get(c.debugStepId) ?? null) : null,
          },
        })
      }

      // 照片同理：元数据复制，图片对象共享
      for (const p of src.photos) {
        const created = await tx.boardPhoto.create({
          data: {
            projectId: project.id,
            objectKey: p.objectKey,
            side: p.side,
            alignmentJson: p.alignmentJson ?? undefined,
          },
        })
        if (p.visualFindings.length > 0) {
          await tx.visualFinding.createMany({
            data: p.visualFindings.map((f) => ({
              photoId: created.id,
              code: f.code,
              title: f.title,
              detail: f.detail,
              confidence: f.confidence,
              severity: f.severity,
              componentRef: f.componentRef,
            })),
          })
        }
        for (const a of p.annotations) {
          await tx.photoAnnotation.create({
            data: {
              photoId: created.id,
              componentId: a.componentId ? (compId.get(a.componentId) ?? null) : null,
              netName: a.netName,
              kind: a.kind,
              regionJson: a.regionJson ?? {},
              note: a.note,
              createdBy: a.createdBy,
            },
          })
        }
      }

      return {
        id: project.id,
        name: project.name,
        copied: {
          components: src.components.length,
          nets: src.nets.length,
          testPoints: src.testPoints.length,
          violations: src.violations.length,
          debugSteps: src.debugSteps.length,
          captures: src.captures.length,
          photos: src.photos.length,
        },
      }
    })
  }
}
