# anna-search

> [!IMPORTANT]
> **本项目由 Qwen3.8 Max 模型开发** —— 从技术调研、架构设计、编码实现到调试排障（含 OOM 根因定位），全程由 AI 驱动完成。

Anna's Archive `zlib3_records` 本地 metadata 搜索 MVP：把 21.4GB 的 Z-Library 书目
metadata dump 导入本地 PostgreSQL 16，提供毫秒级关键词搜索，返回 **MD5** 并生成
**Anna's Archive 详情页 URL**。

```
metadata dump (.jsonl.seekable.zst, 21.4GB torrent)
        ↓  aria2c 下载（docker 卷，断点续传）
拉取式流式读取（自研 zstd 逐块解压，内存恒定 ~300MB）
        ↓
本地 PostgreSQL 16（FTS + trigram 索引）
        ↓  COPY 批量导入（1 万行/批，md5 去重/补全合并）
关键词搜索（HTTP API，毫秒级）
        ↓
返回 MD5 + Anna 详情页 URL（https://annas-archive.gl/md5/<md5>）
```

仅索引 Anna's Archive 公开发布的 metadata，不托管、不提供任何书籍内容。

## 实测数据（全量导入）

| 指标 | 数值 |
|---|---|
| 压缩 dump | 21.4 GB（`.jsonl.seekable.zst`） |
| 解析行数 | ~4500 万行（含占位行） |
| 占位/无效行跳过 | ~280 万（`{"metadata":{"missing":1}}` 等） |
| 重复 md5 合并 | ~2100 万（dump 内大量重复记录） |
| **入库唯一记录** | **~2420 万** |
| 导入速率 | ~4.8k 行/秒（受 GIN 索引维护限制） |
| 导入进程内存 | 稳定 ~300 MB RSS（与数据量无关） |
| 搜索延迟 | 毫秒级（本地 FTS） |

## 技术要点

- **数据源**：`aacid zlib3_records` torrent（Z-Library 书目，21.4 GB 压缩）。
  每行 `{"aacid": ..., "metadata": {md5_reported, title, author, ...}}`；
  dump 中含大量 `missing:1` 占位行，导入时自动跳过
- **读取层**（`src/zjsonl.ts`）：纯拉取模式异步生成器，直接调用 zstd 底层绑定，
  按需解压、内存恒定。*刻意不用* Node streams：zstd-napi 的 `DecompressStream`
  忽略 `push()` 背压，消费端停顿时缓冲会无限增长导致 OOM（本项目真实踩过的坑）
- **导入**：每 1 万行 COPY 进临时表 → `INSERT ... ON CONFLICT (md5) DO UPDATE`
  （保留字段更完整的记录）；批次内先按 md5 去重（否则报
  "cannot affect row a second time"）。全程幂等，中断后重跑即可续传补齐
- **搜索**：`pg_trgm` + `unaccent`（搜 "Zizek" 命中 "Žižek"）；全文 0 结果自动降级
  trigram ILIKE（中文等语言的子串匹配，如搜「刘慈」命中「刘慈欣」）
- **详情页**：结果直接附 `url`，域名可配置（默认 `annas-archive.gl`）

## 项目结构

```
anna-search/
├── docker-compose.yml          # postgres:16-alpine + api + downloader(aria2c) profile
├── Dockerfile                  # api 镜像（node:25-alpine，源码编译 zstd-napi）
├── Dockerfile.downloader       # alpine + aria2，run-once 下载容器
├── db/schema.sql               # pg_trgm/unaccent + documents 表 + GIN/trgm 索引
├── scripts/download-dump.sh    # aria2c 拉取 zlib3_records magnet
├── src/
│   ├── zjsonl.ts               # 拉取式 zstd JSONL 读取（内存恒定）
│   ├── record.ts               # dump 行规范化（md5 校验/年份钳制/ISBN 清洗…）
│   ├── ingest.ts               # COPY 批量导入 CLI（--limit 抽样 / --batch）
│   ├── search.ts               # FTS 查询构造 + trigram 降级
│   ├── server.ts               # Express HTTP API
│   ├── config.ts / db.ts
└── tests/                      # vitest：单元 + fixture e2e
```

## 快速开始

前置：Docker Desktop（数据卷约需 ~60 GB 磁盘：21.4GB dump + 20–30GB PG）。

```bash
cp .env.example .env        # 修改 POSTGRES_PASSWORD
docker compose up -d postgres

# 1. 下载 dump（~21.4 GB，aria2c 走 BT/DHT，需要外网；中断可重启续传）
docker compose --profile download run --rm downloader
#    查看进度: docker compose logs -f --tail 5 downloader

# 2. 导入（先抽样验证，再全量；全量约 1.5–2 小时，中断重跑即可）
docker compose run --rm api node dist/ingest.js -i '/data/dumps/*zlib3_records*.zst' -l 100000
docker compose run -d --name ingest-full api node dist/ingest.js -i '/data/dumps/*zlib3_records*.zst'
#    查看进度: docker logs -f ingest-full

# 3. 启动搜索 API
docker compose up -d api
curl 'http://localhost:3000/api/search?q=dune&limit=5'
```

本机直接运行（不走容器）也可以：`npm install && npm run dev`，数据库连接读 `.env` 的 `DATABASE_URL`。

## HTTP API

### `GET /api/search`

| 参数 | 说明 |
|---|---|
| `q` | 关键词（全文检索；多词为 AND 语义） |
| `author` / `language` / `extension` | 过滤，可与 `q` 组合 |
| `isbn` | ISBN（自动去掉连字符比较） |
| `year_from` / `year_to` | 年份范围 |
| `limit` | 1–50，默认 20 |

至少提供一个参数。响应：

```json
{
  "query": "dune",
  "mode": "fts",
  "count": 1,
  "results": [{
    "md5": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "title": "Dune",
    "author": "Frank Herbert",
    "year": 1965,
    "extension": "epub",
    "filesize": 1234567,
    "url": "https://annas-archive.gl/md5/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }]
}
```

`mode`: `fts`（全文）/ `fuzzy`（trigram 降级）/ `filter`（仅过滤）。

示例：

```bash
curl 'http://localhost:3000/api/search?q=design+patterns&extension=pdf&year_from=2020'
curl 'http://localhost:3000/api/search?q=%E4%B8%89%E4%BD%93'          # 中文：三体
curl 'http://localhost:3000/api/search?author=kahneman&limit=10'
curl 'http://localhost:3000/api/search?isbn=978-0-441-17271-9'
```

### `GET /stats`、`GET /health`

## 开发

```bash
npm run dev          # tsx watch 启动 API
npm run ingest -- -i 'path/*.zst' -l 1000   # 本机导入
npm run typecheck    # tsc --noEmit（含 tests）
npm test             # vitest（单元）
RUN_E2E=1 npm test   # 含 e2e（需要 PG，会 TRUNCATE documents！）
```

调试导入：`-e AA_TRACE_FILE=/tmp/trace.log` 可在容器内输出逐批内存跟踪
（`docker cp <container>:/tmp/trace.log .` 取出）。

## 资源需求（全量）

| 项目 | 约 |
|---|---|
| 下载 | 21.4 GB |
| PostgreSQL 落盘 | 20–30 GB |
| 导入内存 | ~300 MB（拉取式读取，与数据量无关） |
| 导入耗时 | 1.5–2 小时（~4.5k 行/秒，受 GIN 索引维护限制） |

## 已知问题 / 踩坑记录

- **zstd-napi 流式背压缺陷**：`DecompressStream` 忽略 `push()` 返回值，消费端停顿
  （如 DB 写入）时解压缓冲无限增长 → OOM。解决：自研拉取式读取层（`src/zjsonl.ts`）
- **commander 的 `Number.parseInt` 陷阱**：commander 以 `fn(value, previous)` 调用解析
  函数，`--batch 10000` 变成 `parseInt('10000', 10000)`（radix 非法）→ NaN →
  `batch.length >= NaN` 恒为 false，批次永不 flush。现已用
  `(v) => Number.parseInt(v, 10)` + 运行时校验规避
- **异常关机**：导入进行中直接断电可能导致 Docker Desktop 的 containerd 元数据库
  （`meta.db`）损坏（SIGBUS panic）。修复：WSL 内挂载数据盘，将
  `data/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db` 改名，
  重启后自动重建（镜像需重建/重拉，卷数据不受影响）

## 免责声明

- 本项目仅索引 Anna's Archive 公开发布的 metadata，不托管或分发任何受版权保护的内容
- 详情页/下载行为由用户自行访问 Anna's Archive 完成，请遵守当地法律法规
- 与 Anna's Archive 无任何关联

## 致谢 / 参考

- 数据：[Anna's Archive datasets/torrents](https://annas-archive.gl/datasets)
- 方案参考：[hunterchen7/annas-archive-mcp](https://github.com/hunterchen7/annas-archive-mcp)（schema 与导入策略）

---

> 由 **Qwen3.8 Max** 开发 · 调研 → 架构 → 实现 → 排障全流程
