/**
 * 最小 zip 写入器（只用 store 方式，不压缩）。
 *
 * 只为测试打包 fixture 用。不引 archiver/jszip 这类依赖：safeUnzip 本身就是
 * 手写的 zip 读取器（method 0 与 8 都支持），为了打个几十 KB 的测试包再拉一个
 * 生产依赖进来不划算，而且依赖越少，「解析真实工程」这条链路越可信。
 *
 * 不支持：目录条目、zip64、加密、注释。fixture 用不到。
 */
import { crc32 } from 'node:zlib'

export interface ZipEntry {
  /** 归档内路径，必须用 / 分隔 */
  name: string
  data: Buffer
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(0, 10) // mtime
    local.writeUInt16LE(0, 12) // mdate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.byteLength, 18)
    local.writeUInt32LE(e.data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10) // stored
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.byteLength, 20)
    central.writeUInt32LE(e.data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    // 高 16 位是 Unix mode。0o100644 = 普通文件，别让 safeUnzip 误判成符号链接。
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, e.data)
    centrals.push(central, name)
    offset += local.byteLength + name.byteLength + e.data.byteLength
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}
