'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AiDiagnosis, Measurements, StepStatus, VisualFindings } from '@app/contracts'
import { API_BASE, queryKeys } from './api'

async function send<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) {
    // 后端把校验失败的原因放在 message 里，直接透给用户比 "500" 有用
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.message ?? `请求失败: ${res.status}`)
  }
  return res.json()
}

/** File → base64（不含 data: 前缀），上传端点要的是纯 base64 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const r = reader.result as string
      resolve(r.slice(r.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

export function useUploadPhoto(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) =>
      send<{ id: string; sizeBytes: number }>(`/projects/${projectId}/photos`, {
        filename: file.name,
        mimeType: file.type,
        base64: await fileToBase64(file),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.photos(projectId) }),
  })
}

export function useCreateAnnotation(projectId: string, photoId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      kind: 'component' | 'solder' | 'damage' | 'question'
      region: { x: number; y: number; w: number; h: number }
      note?: string
      componentRef?: string
    }) => send<{ id: string }>(`/photos/${photoId}/annotations`, { ...input, createdBy: 'ZH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.photos(projectId) }),
  })
}

export function useDeleteAnnotation(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => send<{ deleted: boolean }>(`/annotations/${id}`, undefined, 'DELETE'),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.photos(projectId) }),
  })
}

export function useAnalyzePhoto(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (photoId: string) =>
      send<VisualFindings>('/ai/analyze-photo', { photoId, persist: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.photos(projectId) }),
  })
}

export function useUpdateStep(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      stepId: string
      status?: StepStatus
      result?: Record<string, unknown>
    }) =>
      send<{ id: string; status: string }>(
        `/debug-steps/${input.stepId}`,
        { status: input.status, result: input.result },
        'PATCH',
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.plan(projectId) })
      qc.invalidateQueries({ queryKey: queryKeys.activity(projectId) })
      qc.invalidateQueries({ queryKey: queryKeys.project(projectId) })
    },
  })
}

export function useCreateStep(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string; objective?: string; toolHint?: string }) =>
      send<{ id: string }>(`/projects/${projectId}/debug-steps`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.plan(projectId) }),
  })
}

export function useSaveCapture(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      label?: string
      netName?: string
      debugStepId?: string
      hardwareSetup: Record<string, unknown>
      measurements: Measurements
      waveform?: { ch1: number[]; ch2: number[]; fs: number }
    }) => send<{ id: string }>(`/projects/${projectId}/captures`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.captures(projectId) })
      qc.invalidateQueries({ queryKey: queryKeys.activity(projectId) })
      qc.invalidateQueries({ queryKey: queryKeys.project(projectId) })
    },
  })
}

export function useAnalyzeCapture(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (captureId: string) =>
      send<AiDiagnosis>('/ai/analyze-capture', { captureId, persist: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.diagnosis(projectId) })
      qc.invalidateQueries({ queryKey: queryKeys.activity(projectId) })
    },
  })
}

export function useGenerateReport(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      send<{ id: string; version: string; stats: Record<string, number> }>(
        `/projects/${projectId}/reports`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.report(projectId) }),
  })
}
