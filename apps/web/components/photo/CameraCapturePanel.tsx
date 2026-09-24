'use client'

import { useEffect, useRef, useState } from 'react'
import { SectionCard, cn } from '@app/ui'
import { useAnalyzePhoto, useUploadPhoto } from '@/lib/mutations'

type Source = 'uvc' | 'recamera' | 's31'

type StatusKind = 'idle' | 'ok' | 'warn'

const DEFAULT_RECAMERA_BRIDGE_PORT = '18765'
const DEFAULT_S31_BRIDGE_PORT = '18766'

function waitForIce(pc: RTCPeerConnection, timeoutMs = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(done, timeoutMs)
    function done() {
      window.clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    function onChange() {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

async function continuousFocus(track: MediaStreamTrack) {
  try {
    const caps = track.getCapabilities?.() as MediaTrackCapabilities & { focusMode?: string[] }
    if (caps?.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
      return '连续 AF'
    }
  } catch {
    // Some UVC cameras autofocus in firmware without exposing focusMode to the browser.
  }
  return /insta360|link\s*2|link\s*2c/i.test(track.label) ? '相机固件 AF' : '设备默认对焦'
}

export function CameraCapturePanel({ projectId }: { projectId: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const s31PreviewUrlRef = useRef<string | null>(null)
  const s31PreviewBusyRef = useRef(false)

  const [source, setSource] = useState<Source>('uvc')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [cameraIp, setCameraIp] = useState('192.168.42.1')
  const [cameraUser, setCameraUser] = useState('admin')
  const [cameraPassword, setCameraPassword] = useState('')
  const [cameraRtspPath, setCameraRtspPath] = useState('/main')
  const [cameraBridgePort, setCameraBridgePort] = useState(DEFAULT_RECAMERA_BRIDGE_PORT)
  const [s31Ip, setS31Ip] = useState('192.168.1.100')
  const [s31Token, setS31Token] = useState('')
  const [s31BridgePort, setS31BridgePort] = useState(DEFAULT_S31_BRIDGE_PORT)
  const [s31Resolution, setS31Resolution] = useState('3840x2160')
  const [s31Quality, setS31Quality] = useState(92)
  const [s31PreviewUrl, setS31PreviewUrl] = useState('')
  const [s31AutoPreview, setS31AutoPreview] = useState(false)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('摄像头未连接')
  const [statusKind, setStatusKind] = useState<StatusKind>('idle')
  const [result, setResult] = useState<string | null>(null)

  const upload = useUploadPhoto(projectId)
  const analyze = useAnalyzePhoto(projectId)

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    try {
      pcRef.current?.close()
    } catch {}
    pcRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    if (s31PreviewUrlRef.current) URL.revokeObjectURL(s31PreviewUrlRef.current)
    s31PreviewUrlRef.current = null
    setS31PreviewUrl('')
    setConnected(false)
    setStatus('摄像头未连接')
    setStatusKind('idle')
  }

  const refreshDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const cams = all.filter((d) => d.kind === 'videoinput')
      setDevices(cams)
      if (!deviceId && cams[0]?.deviceId) setDeviceId(cams[0].deviceId)
    } catch (e) {
      setStatus(`设备枚举失败：${(e as Error).message}`)
      setStatusKind('warn')
    }
  }

  useEffect(() => {
    void refreshDevices()
    return stop
  }, [])

  const connectUvc = async () => {
    stop()
    setStatus('正在连接 USB/UVC 摄像头…')
    setStatusKind('idle')
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? {
            deviceId: { exact: deviceId },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
            frameRate: { ideal: 30, max: 30 },
          }
        : {
            width: { ideal: 3840 },
            height: { ideal: 2160 },
            frameRate: { ideal: 30, max: 30 },
          },
      audio: false,
    })
    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    }
    const track = stream.getVideoTracks()[0]
    const settings = track?.getSettings()
    const focus = track ? await continuousFocus(track) : '—'
    setConnected(true)
    setStatus(`${track?.label || 'UVC Camera'} · ${settings?.width ?? '?'}×${settings?.height ?? '?'} · ${focus}`)
    setStatusKind('ok')
    await refreshDevices()
  }

  const connectReCamera = async () => {
    stop()
    setStatus('正在连接 reCamera Pro WebRTC…')
    setStatusKind('idle')

    const bridgePort = Number(cameraBridgePort.trim() || DEFAULT_RECAMERA_BRIDGE_PORT)
    if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
      throw new Error('Bridge 端口必须是 1–65535 的整数')
    }
    setCameraBridgePort(String(bridgePort))
    const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
    const health = await fetch(`${bridgeOrigin}/health`, { cache: 'no-store' })
    if (!health.ok) throw new Error('LabSight reCamera WebRTC 后台服务未就绪')

    const pc = new RTCPeerConnection()
    pcRef.current = pc
    pc.addTransceiver('video', { direction: 'recvonly' })

    const remoteStream = new MediaStream()
    pc.ontrack = (event) => {
      if (event.track.kind !== 'video') return
      remoteStream.addTrack(event.track)
      streamRef.current = remoteStream
      if (videoRef.current) {
        videoRef.current.srcObject = remoteStream
        void videoRef.current.play()
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnected(true)
        setStatus('reCamera Pro · Wi-Fi / WebRTC · 已连接')
        setStatusKind('ok')
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setStatus(`reCamera WebRTC ${pc.connectionState}`)
        setStatusKind('warn')
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIce(pc)

    const trimmedRtspPath = cameraRtspPath.trim() || '/main'
    const rtspPath = trimmedRtspPath.startsWith('/') ? trimmedRtspPath : `/${trimmedRtspPath}`
    setCameraRtspPath(rtspPath)

    const r = await fetch(`${bridgeOrigin}/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sdp: pc.localDescription?.sdp,
        type: pc.localDescription?.type,
        camera_ip: cameraIp.trim(),
        username: cameraUser.trim() || 'admin',
        password: cameraPassword,
        rtsp_path: rtspPath,
      }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `WebRTC Bridge HTTP ${r.status}`)
    await pc.setRemoteDescription(data)
  }

  const s31BridgeOrigin = () => {
    const port = Number(s31BridgePort.trim() || DEFAULT_S31_BRIDGE_PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('S31 Bridge 端口必须是 1–65535 的整数')
    }
    setS31BridgePort(String(port))
    return `http://127.0.0.1:${port}`
  }

  const requestS31Jpeg = async (purpose: 'preview' | 'ai_inspection' | 'evidence') => {
    if (s31PreviewBusyRef.current && purpose === 'preview') return null
    if (purpose === 'preview') s31PreviewBusyRef.current = true
    try {
      const bridge = s31BridgeOrigin()
      const r = await fetch(`${bridge}/capture`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resolution: s31Resolution,
          quality: s31Quality,
          purpose,
        }),
      })
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}))
        throw new Error(detail.detail || detail.error || `S31 Bridge HTTP ${r.status}`)
      }
      const blob = await r.blob()
      if (!blob.type.startsWith('image/')) throw new Error('S31 返回的不是图像数据')
      return blob
    } finally {
      if (purpose === 'preview') s31PreviewBusyRef.current = false
    }
  }

  const refreshS31Preview = async () => {
    try {
      const blob = await requestS31Jpeg('preview')
      if (!blob) return
      const nextUrl = URL.createObjectURL(blob)
      if (s31PreviewUrlRef.current) URL.revokeObjectURL(s31PreviewUrlRef.current)
      s31PreviewUrlRef.current = nextUrl
      setS31PreviewUrl(nextUrl)
    } catch (e) {
      setStatus(`S31 预览失败：${(e as Error).message}`)
      setStatusKind('warn')
    }
  }

  const connectS31 = async () => {
    stop()
    setStatus('正在连接 ESP32-S31 Edge Camera…')
    setStatusKind('idle')
    if (!s31Ip.trim()) throw new Error('请输入 ESP32-S31 的局域网 IP 或 .local 主机名')

    const bridge = s31BridgeOrigin()
    const configured = await fetch(`${bridge}/configure`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_ip: s31Ip.trim(),
        token: s31Token,
      }),
    })
    const cfg = await configured.json().catch(() => ({}))
    if (!configured.ok) throw new Error(cfg.detail || cfg.error || `S31 Bridge HTTP ${configured.status}`)

    const deviceRes = await fetch(`${bridge}/device?t=${Date.now()}`, { cache: 'no-store' })
    const device = await deviceRes.json().catch(() => ({}))
    if (!deviceRes.ok) throw new Error(device.detail || device.error || 'S31 Device API 未就绪')

    const camera = device.camera || device.capabilities?.camera || {}
    const deviceId = device.deviceId || device.id || 'ESP32-S31'
    const maxResolution = camera.maxResolution || camera.max_resolution || s31Resolution
    setConnected(true)
    setStatus(`${deviceId} · Edge Camera · ${maxResolution} · JPEG Snapshot`)
    setStatusKind('ok')
    await refreshS31Preview()
  }

  const connect = async () => {
    setResult(null)
    try {
      if (source === 'recamera') await connectReCamera()
      else if (source === 's31') await connectS31()
      else await connectUvc()
    } catch (e) {
      stop()
      setStatus(`连接失败：${(e as Error).message}`)
      setStatusKind('warn')
    }
  }

  const captureFile = async () => {
    if (source === 's31') {
      const blob = await requestS31Jpeg('evidence')
      if (!blob) throw new Error('S31 没有返回可保存的 JPEG')
      return new File([blob], `s31-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, {
        type: blob.type || 'image/jpeg',
      })
    }

    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) throw new Error('当前还没有可抓取的视频帧')
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 初始化失败')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (!blob) throw new Error('截图编码失败')
    return new File([blob], `camera-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, {
      type: 'image/jpeg',
    })
  }

  const captureAndAnalyze = async (analyzeNow: boolean) => {
    setBusy(true)
    setResult(null)
    try {
      const file = await captureFile()
      const saved = await upload.mutateAsync(file)
      if (!analyzeNow) {
        setResult(`已抓取并保存 ${(saved.sizeBytes / 1024).toFixed(0)} KB 高清照片。`)
        return
      }
      const finding = await analyze.mutateAsync(saved.id)
      if (!finding.findings.length) {
        setResult('检测完成：当前画面没有检出需要报告的异常。')
        return
      }
      const top = finding.findings.slice(0, 3)
      setResult(
        `检测完成：${top
          .map((f) => `${f.componentRef ? `${f.componentRef}：` : ''}${f.title}（${Math.round(f.confidence * 100)}%）`)
          .join('；')}`,
      )
    } catch (e) {
      setResult(`操作失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (source !== 's31' || !connected || !s31AutoPreview) return
    const timer = window.setInterval(() => {
      void refreshS31Preview()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [source, connected, s31AutoPreview, s31BridgePort, s31Resolution, s31Quality])

  return (
    <SectionCard
      title="LabSight 实时摄像头"
      action={
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px]',
            statusKind === 'ok' && 'bg-emerald-50 text-emerald-600',
            statusKind === 'warn' && 'bg-amber-50 text-amber-700',
            statusKind === 'idle' && 'bg-slate-100 text-slate-500',
          )}
        >
          {status}
        </span>
      }
      bodyClassName="p-3"
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative aspect-video overflow-hidden rounded-lg bg-slate-950">
          {source === 's31' ? (
            s31PreviewUrl ? <img src={s31PreviewUrl} alt="ESP32-S31 高清帧" className="h-full w-full object-contain" /> : null
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
          )}
          {!connected && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
              连接摄像头后可直接抓取高清 PCB 图像
            </div>
          )}
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block font-medium text-slate-600">摄像头来源</label>
            <select
              value={source}
              onChange={(e) => {
                stop()
                setSource(e.target.value as Source)
              }}
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2"
            >
              <option value="uvc">USB / UVC（含 Insta360 Link）</option>
              <option value="s31">ESP32-S31 Edge Camera（Wi-Fi / 8MP Snapshot）</option>
              <option value="recamera">Seeed reCamera Pro（Wi-Fi / WebRTC）</option>
            </select>
          </div>

          {source === 'uvc' ? (
            <div>
              <label className="mb-1 block font-medium text-slate-600">摄像头</label>
              <div className="flex gap-2">
                <select
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-2"
                >
                  {devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => void refreshDevices()} className="rounded-lg bg-slate-100 px-2.5 text-slate-600">
                  刷新
                </button>
              </div>
            </div>
          ) : source === 'recamera' ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2">
                <span className="mb-1 block font-medium text-slate-600">reCamera Pro IP</span>
                <input value={cameraIp} onChange={(e) => setCameraIp(e.target.value)} className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label>
                <span className="mb-1 block font-medium text-slate-600">用户名</span>
                <input value={cameraUser} onChange={(e) => setCameraUser(e.target.value)} className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label>
                <span className="mb-1 block font-medium text-slate-600">密码</span>
                <input type="password" value={cameraPassword} onChange={(e) => setCameraPassword(e.target.value)} className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label className="col-span-2">
                <span className="mb-1 block font-medium text-slate-600">RTSP 路径</span>
                <input value={cameraRtspPath} onChange={(e) => setCameraRtspPath(e.target.value)} placeholder="/main" className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label className="col-span-2">
                <span className="mb-1 block font-medium text-slate-600">Bridge 端口</span>
                <input type="number" min={1} max={65535} value={cameraBridgePort} onChange={(e) => setCameraBridgePort(e.target.value)} placeholder={DEFAULT_RECAMERA_BRIDGE_PORT} className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <p className="col-span-2 text-[10px] leading-4 text-slate-400">
                使用本机 LabSight WebRTC Bridge（127.0.0.1，端口可配置），安装一次后随 macOS / Windows 登录自动运行。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2">
                <span className="mb-1 block font-medium text-slate-600">ESP32-S31 地址</span>
                <input value={s31Ip} onChange={(e) => setS31Ip(e.target.value)} placeholder="192.168.1.100 或 labsight-s31.local" className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label>
                <span className="mb-1 block font-medium text-slate-600">分辨率</span>
                <select value={s31Resolution} onChange={(e) => setS31Resolution(e.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                  <option value="3840x2160">3840×2160 / 4K</option>
                  <option value="3264x2448">3264×2448 / 8MP 4:3</option>
                  <option value="1920x1080">1920×1080</option>
                  <option value="1280x720">1280×720</option>
                </select>
              </label>
              <label>
                <span className="mb-1 block font-medium text-slate-600">JPEG Quality</span>
                <input type="number" min={50} max={100} value={s31Quality} onChange={(e) => setS31Quality(Math.max(50, Math.min(100, Number(e.target.value) || 92)))} className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label>
                <span className="mb-1 block font-medium text-slate-600">Bridge 端口</span>
                <input type="number" min={1} max={65535} value={s31BridgePort} onChange={(e) => setS31BridgePort(e.target.value)} placeholder={DEFAULT_S31_BRIDGE_PORT} className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label>
                <span className="mb-1 block font-medium text-slate-600">设备 Token（可选）</span>
                <input type="password" value={s31Token} onChange={(e) => setS31Token(e.target.value)} placeholder="Bearer token" className="w-full rounded-lg border border-slate-200 px-2.5 py-2" />
              </label>
              <label className="col-span-2 flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-slate-600">
                <input type="checkbox" checked={s31AutoPreview} onChange={(e) => setS31AutoPreview(e.target.checked)} />
                <span>AI Inspect：每秒抓取 1 张高清 JPEG 作为预览（不会自动上传/调用 AI）</span>
              </label>
              <p className="col-span-2 text-[10px] leading-4 text-slate-400">
                浏览器通过本机 S31 Edge Bridge（127.0.0.1）访问局域网设备，避免 HTTPS 页面直接访问 HTTP 私网设备的限制。真正保存/AI 分析时才进入项目 BoardPhoto / Evidence 流程。
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <button type="button" onClick={() => void connect()} className="flex-1 rounded-lg bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-700">
              {connected ? '重新连接' : source === 's31' ? '连接 S31 Edge Camera' : '连接摄像头'}
            </button>
            {connected && source === 's31' && (
              <button type="button" onClick={() => void refreshS31Preview()} className="rounded-lg bg-slate-100 px-3 py-2 text-slate-600">
                刷新高清帧
              </button>
            )}
            {connected && (
              <button type="button" onClick={stop} className="rounded-lg bg-slate-100 px-3 py-2 text-slate-600">
                断开
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!connected || busy}
              onClick={() => void captureAndAnalyze(false)}
              className="rounded-lg bg-slate-100 px-3 py-2 font-medium text-slate-700 disabled:opacity-40"
            >
              抓取并保存
            </button>
            <button
              type="button"
              disabled={!connected || busy}
              onClick={() => void captureAndAnalyze(true)}
              className="rounded-lg bg-emerald-600 px-3 py-2 font-medium text-white disabled:opacity-40"
            >
              {busy ? '处理中…' : '拍照并 AI 检测'}
            </button>
          </div>

          {result && <div className="rounded-lg bg-slate-50 p-2.5 leading-5 text-slate-600">{result}</div>}
        </div>
      </div>
    </SectionCard>
  )
}
