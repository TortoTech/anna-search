# anna-search

Anna's Archive `zlib3_records` 本地 metadata 搜索 MVP。

```
metadata dump (.jsonl.seekable.zst, 21.4GB torrent)
        ↓  aria2c 下载（docker 卷）
拉取式流式读取（自研 zstd 逐块解压，内存恒定）
        ↓
本地 PostgreSQL 16（FTS + trigram 索引）
        ↓  COPY 批量导入（1 万行/批，md5 去重/补全合并）
关键词搜索（HTTP API）
        ↓
返回 MD5 + Anna 详情页 URL（https://annas-archive.gl/md5/<md5>）
```

仅索引 Anna's Archive 公开发布的 metadata，不托管任何书籍内容。

## 技术要点

- **数据源**：`aacid zlib3_records` torrent（Z-Library 书目，22M+ 有效记录，21.4 GB 压缩）。
  文件格式 `.jsonl.seekable.zst`，每行 `{"aacid": ..., "metadata": {md5_reported, title, author, ...}}`；
  dump 中含大量 `{"metadata":{"missing":1}}` 占位行，导入时自动跳过（约占 40–60%）
- **读取层**（`src/zjsonl.ts`）：纯拉取模式异步生成器，直接调用 zstd 底层绑定，
  按需解压、内存恒定（~300MB RSS）。*不用* Node streams：zstd-napi 的 `DecompressStream`
  忽略 `push()` 背压，消费端停顿时缓冲会无限增长导致 OOM
- **导入**：每 1 万行 COPY 进临时表 → `INSERT ... ON CONFLICT (md5) DO UPDATE`
  （保留字段更完整的记录）；批次内先按 md5 去重（dump 含重复记录，否则
  `ON CONFLICT` 会报 "cannot affect row a second time"）
- **搜索**：`pg_trgm` + `unaccent`（搜 "Zizek" 命中 "Žižek"）；全文 0 结果自动降级
  trigram ILIKE（中文等语言的子串匹配）
- **详情页**：结果直接附 `url`，域名可配置（默认 `annas-archive.gl`）

## 快速开始

```bash
cp .env.example .env        # 修改 POSTGRES_PASSWORD
docker compose up -d postgres

# 1. 下载 dump（~21.4 GB，aria2c 走 BT/DHT，需要外网；中断可重启续传）
docker compose --profile download run --rm downloader
#    查看进度: docker compose logs -f --tail 5 downloader

# 2. 导入（先抽样验证，再全量；全量约 1.5–2 小时）
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

## 致谢 / 参考

- 数据：[Anna's Archive datasets/torrents](https://annas-archive.gl/datasets)
- 方案参考：[hunterchen7/annas-archive-mcp](https://github.com/hunterchen7/annas-archive-mcp)（schema 与导入策略）
