# 09 · 对象存储验证

两种 adapter：`mock`（本地盘/内存）与 `s3`（任何 S3 兼容端点）。
**生产必须用 `s3`。** 这一条在代码里是硬校验，不是建议。

---

## 1. 当前验证状态

| 项 | 状态 |
| --- | --- |
| mock adapter（put/get/head/delete/presign 回落） | ✅ 单元测试覆盖 |
| objectKey 安全校验（前缀、`..`、控制字符） | ✅ 单元测试覆盖 |
| 生产禁用 mock 的启动校验 | ✅ 单元测试覆盖 |
| S3 adapter 对真实 HTTP 端点（签名、head、直传 URL） | ✅ 进程内 S3 协议假服务，CI 每次跑 |
| **MinIO** | ✅ CI 每次推送都跑（`存储（MinIO 端到端）` job，7/7） |
| **Cloudflare R2** | ❌ 未跑过 |
| **AWS S3** | ❌ 未跑过 |

MinIO 已验证不等于 R2/AWS 也没问题：region 语义、path-style、CORS、
桶策略在三家上并不一样。换端点后请重跑一次 `pnpm test:storage-real`。

`packages/storage/test/s3-adapter.test.ts` 起了一个进程内的 S3 协议 HTTP 服务，
请求真的经过 AWS SDK 签名、真的走 HTTP、响应头真的被 SDK 解析。它能挡住
「head 读错了字段」「presign URL 拼错了」这类退化，但**挡不住**真实对象存储
才有的东西：分片上传、CORS、区域路由、桶策略、`ContentLength` 签名被服务端
真正校验时的行为。那些要靠下面的 `pnpm test:storage-real`。

---

## 2. 本地用 MinIO 验证

```bash
docker compose -f docker-compose.storage.yml up -d
```

起来两个容器：`bdc-minio`（9000 API / 9001 控制台）与一次性的 `bdc-minio-init`
（建 `bdc-test` 桶后退出）。都只绑 `127.0.0.1`。

```bash
S3_ENDPOINT=http://127.0.0.1:9000 \
S3_BUCKET=bdc-test \
S3_ACCESS_KEY_ID=bdc-test-key \
S3_SECRET_ACCESS_KEY=bdc-test-secret \
S3_FORCE_PATH_STYLE=true \
  pnpm test:storage-real
```

没配这几个变量就打印 `SKIPPED` 并退 0 —— CI 不该依赖外部资源。

验的七件事：

1. `put` + `head`：大小与 Content-Type 都对得上
2. `head` 不存在的 key 返回 `null` 而不是抛错
3. `get`：二进制内容逐字节一致
4. `getSignedReadUrl`：签名 URL 能真的取到对象
5. `createPresignedUpload`：直传 PUT 成功后，服务端**只 head 就能校验**；
   且多传一个字节会被对象存储以 `SignatureDoesNotMatch` 拒掉
6. 超限对象被拒绝**并从存储里删掉**
7. `delete` 之后 `head` 与 `get` 都取不到

跑完自动清理测试对象（失败也清）。

用完关掉：

```bash
docker compose -f docker-compose.storage.yml down -v
```

控制台在 http://127.0.0.1:9001（bdc-test-key / bdc-test-secret），想看对象
实际长什么样时有用。

---

## 3. Cloudflare R2

```bash
STORAGE_ADAPTER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=board-debug-copilot
S3_ACCESS_KEY_ID=<R2 API Token 的 Access Key ID>
S3_SECRET_ACCESS_KEY=<Secret Access Key>
S3_FORCE_PATH_STYLE=true
```

要点：

- **region 必须是 `auto`**，R2 不认真实区域名。
- **必须 path-style**（默认就是 true）。virtual-host style 在 R2 上会 404。
- API Token 权限选 **Object Read & Write**，作用域限到这一个桶。
- 桶保持私有。读取一律走签名 URL，不要开公共访问 —— 私有项目的原理图和
  照片不该靠「URL 猜不到」来保密。
- 直传要在桶上配 CORS，允许前端域名的 `PUT`：

```json
[
  {
    "AllowedOrigins": ["https://board-debug-copilot.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type", "content-length"],
    "MaxAgeSeconds": 3600
  }
]
```

配好后用同一条命令验：

```bash
S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  pnpm test:storage-real
```

---

## 4. AWS S3

```bash
STORAGE_ADAPTER=s3
# S3_ENDPOINT 留空，用 AWS 默认端点
S3_REGION=ap-northeast-1
S3_BUCKET=board-debug-copilot
S3_ACCESS_KEY_ID=<IAM 用户的 Access Key>
S3_SECRET_ACCESS_KEY=<Secret>
S3_FORCE_PATH_STYLE=false
```

要点：

- **`S3_REGION` 必须是真实区域**，`auto` 在 AWS 上会签名失败。
- `S3_FORCE_PATH_STYLE` 显式设 `false`（代码默认是 true，为 R2/MinIO 准备的）。
- IAM 策略最小化到这个桶：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:HeadObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::board-debug-copilot/projects/*"
    }
  ]
}
```

`Resource` 限到 `projects/*`：应用本来就只在这个前缀下读写
（`assertSafeObjectKey` 保证），桶策略再兜一层。

- Block Public Access 全开，读走签名 URL。

---

## 5. mock 与 s3 的差异

| | `STORAGE_ADAPTER=mock` | `STORAGE_ADAPTER=s3` |
| --- | --- | --- |
| 对象存哪 | 容器本地盘 `./storage/`，无盘时退进程内存 | 对象存储 |
| 重启后 | 挂了卷才在；没挂卷 / 退了内存 → **全丢** | 在 |
| 多实例 | 各存各的，api 与 worker 互相看不到对方的产物 | 共享 |
| 读取 | 走 API 的 `GET /api/v1/files/:key` | 对象存储签发的签名 URL |
| 上传 | 前端 base64 发给 API，整个文件过一遍 Node 进程 | 浏览器直传，不经过 API |
| 权限 | API 自己判（按 key 里的 projectId 查归属） | 桶策略 + 签名有效期 |
| 100MB zip | API 进程峰值内存翻倍 | API 只 head，不碰内容 |

### 为什么生产不能用 mock

三条，任何一条单独就够：

1. **数据会消失。** Railway / Vercel 的容器随时重建。没挂持久卷就是重启即丢；
   `MockStorage` 在写盘失败时还会静默退回进程内存，那时连重启都不用等。
2. **api 与 worker 看不到对方的文件。** worker 解析 zip 产出的 SVG 写在 worker
   容器的盘上，api 去读只会 404。单机跑不出这个问题，一上多实例就必现。
3. **没有对象级权限。** 读取要靠 API 自己开的 `/files` 路由代劳。那条路由做了
   归属校验（公共 Demo 可读，私有项目要 token），但它是给本地开发和内置 Demo
   用的，不是设计成生产授权层的 —— 它没有签名有效期、没有速率限制、
   缓存策略也由应用自己拍。

### 直传的大小限制怎么落地

presigned PUT 没法表达「不超过 N 字节」——签名要么把 `content-length` 签死，
要么不签。所以走两道：

1. **签确切长度。** `presignUpload` 拿到客户端声明的 `sizeBytes`，先用
   `LIMITS` 校验，然后把这个确切值签进 `content-length`。传多传少都会在
   对象存储侧被拒，字节根本落不了地。
2. **完成时 head 复核。** `completeUpload` 用 `head()` 拿真实大小再校验一次，
   超限就把对象删掉。

两道防的是不同的事：第一道防「传超了」，第二道防「签的时候就撒谎」。

> 早先第一道签的是 `LIMITS.zip.maxBytes`（上限而不是确切值），于是任何一次
> 真实上传的 content-length 都对不上签名 —— MinIO 直接回 `SignatureDoesNotMatch`。
> 进程内的假 S3 服务不校验签名，没发现；CI 的 MinIO job 第一次跑就抓到了。
> 这就是为什么假服务替代不了真 MinIO。

### 硬校验

`NODE_ENV=production` + 实际 adapter 是 mock + 没有显式豁免 → **API 与 worker
拒绝启动**，并在第一行日志打出该配什么。

选「启动失败」而不是「health 报 unhealthy」：带病运行的话，每一次上传都在
制造将来会凭空消失的数据，而问题要等到用户发现文件没了才暴露。起不来，
运维立刻就知道。

显式豁免（**只给内置 Demo 用**）：

```bash
ALLOW_MOCK_STORAGE_IN_PRODUCTION=true
```

豁免之后进程能起，但 `/health` 里 `storage.degraded` 仍是 `true` ——
豁免的是「不许启动」，不是「这是个好配置」。

如果启动校验被绕过（比如直接 import `AppModule` 起服务），`/health` 会返回
**HTTP 503** 且 `status: "unhealthy"`，编排器看到的不会是绿灯。

---

## 6. 从 mock 迁到 s3

1. 建桶、建凭据，按第 3/4 节配好变量。
2. `pnpm test:storage-real` 跑通。
3. 给服务加上 `STORAGE_ADAPTER=s3` 与四个 `S3_*` 变量，**api 与 worker 都要加**。
4. 重启后确认 `/health` 里 `storage.adapter === "s3"` 且 `degraded === false`。
5. 已经躺在 mock 里的旧对象不会自动迁移。要保就手工 `mc mirror` /
   `aws s3 sync` 一次；内置 Demo 的数据由 seed 重建，不用迁。

配置不全时不会崩，而是降级为 mock 并在 `/health` 的 `storage.degraded`
与 `storage.reason` 里说清楚 —— 但在生产环境，这个降级会直接变成启动失败。
