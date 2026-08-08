'use client'

import type { Report } from './api'

/**
 * 报告导出。
 *
 * PDF 走浏览器打印：无服务端 headless Chrome、无额外依赖，且用户能在打印
 * 对话框里选纸张与页边距。A4 版式由 @media print 控制（见 globals.css）。
 *
 * DOCX 用 Word 认得的 HTML 封装（MHTML 风格），不引 docx 库。
 * Word/WPS/Pages 都能正常打开并保留标题、表格、列表样式。
 */

export function exportPdf() {
  // 打印当前页；.print-only / .no-print 由 CSS 决定谁出现在纸上
  window.print()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Markdown → 适合 Word 的 HTML。覆盖报告实际用到的语法。 */
export function markdownToHtml(md: string): string {
  const out: string[] = []
  const lines = md.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const lv = h[1]!.length
      out.push(`<h${lv}>${escapeHtml(h[2]!)}</h${lv}>`)
      i++
      continue
    }

    if (line.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i]!
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells)
        i++
      }
      out.push(
        '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%">',
        ...rows.map(
          (r) =>
            '<tr>' +
            r
              .map(
                (c, ci) =>
                  `<td${ci === 0 ? ' style="background:#f1f5f9;font-weight:600"' : ''}>${escapeHtml(c)}</td>`,
              )
              .join('') +
            '</tr>',
        ),
        '</table>',
      )
      continue
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s*/, ''))
        i++
      }
      out.push('<ol>', ...items.map((t) => `<li>${escapeHtml(t)}</li>`), '</ol>')
      continue
    }

    if (line.startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && lines[i]!.startsWith('- ')) {
        items.push(lines[i]!.slice(2))
        i++
      }
      out.push('<ul>', ...items.map((t) => `<li>${escapeHtml(t)}</li>`), '</ul>')
      continue
    }

    // **粗体** 是报告里唯一用到的行内标记
    out.push(`<p>${escapeHtml(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`)
    i++
  }
  return out.join('\n')
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function exportMarkdown(report: Report) {
  download(
    new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' }),
    `${report.title}-${report.version}.md`,
  )
}

export function exportDocx(report: Report) {
  const stats = report.stats
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(report.title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  @page { size: A4; margin: 2cm; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 10.5pt; line-height: 1.6; }
  h1 { font-size: 18pt; } h2 { font-size: 14pt; margin-top: 18pt; } h3 { font-size: 12pt; }
  table { font-size: 9.5pt; margin: 10pt 0; }
  .meta { color: #64748b; font-size: 9pt; border-bottom: 1px solid #cbd5e1; padding-bottom: 8pt; }
  .stats td { text-align: center; }
</style>
</head>
<body>
<h1>${escapeHtml(report.title)}</h1>
<p class="meta">版本 ${escapeHtml(report.version)} ｜ 作者 ${escapeHtml(report.author ?? '')} ｜ 日期 ${new Date(report.createdAt).toLocaleDateString('zh-CN')} ｜ 工具 Board Debug Copilot</p>
<table border="1" cellspacing="0" cellpadding="6" class="stats" style="border-collapse:collapse;width:100%">
  <tr>
    <td>问题总数<br><b>${stats.issues}</b></td>
    <td>已解决<br><b>${stats.resolved}</b></td>
    <td>优化建议<br><b>${stats.improvements}</b></td>
    <td>测量项<br><b>${stats.measurements}</b></td>
    <td>AI 建议<br><b>${stats.aiSuggestions}</b></td>
  </tr>
</table>
${markdownToHtml(report.markdown)}
</body></html>`

  download(
    new Blob(['﻿', html], { type: 'application/msword;charset=utf-8' }),
    `${report.title}-${report.version}.doc`,
  )
}
