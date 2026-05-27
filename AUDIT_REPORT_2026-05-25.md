# ANN 项目审计报告 v2

**审计日期**: 2026-05-25
**审计范围**: mcp-server-ann/ 全部源码及相关技术文档
**审计标准**: 代码正确性、协议一致性、安全、可靠性、文档准确性、测试覆盖
**参考报告**: AUDIT_REPORT_2026-05-18.md, VERIFICATION_REPORT_2026-05-18.md

---

## 一、已修复项验证（对照 2026-05-18 审计报告）

### P0 阻塞性缺陷（5项）

| # | 问题 | 验证结果 | 证据 |
|---|------|---------|------|
| 1 | `client_sim.mjs` 调用不存在的工具名称 | ✅ 已修复 | `tests/client_sim.mjs` 已更新为 `publish_knowledge` / `search_knowledge` |
| 2 | `e2e-federation.mjs` 引用已移除的 `ann-hub` | ✅ 已修复 | 脚本已重写为纯 P2P MCP 测试，无 ann-hub 引用 |
| 3 | CI 配置引用已移除的 Go 和 ann-hub 组件 | ✅ 已修复 | `.github/workflows/ci.yml` 已更新为仅 Node.js 构建 |
| 4 | ANP 签名格式实现与文档规范不一致 | ✅ 已修复 | `index.ts` 和 `p2p.ts` 均使用 `[0, pubkey, timestamp, kind, cid, related_cid]` 格式，文档已同步更新 |
| 5 | `nacl.sign` 误用导致签名格式非标准 | ✅ 已修复 | `index.ts` 使用 `nacl.sign.detached`，`p2p.ts` 使用 `nacl.sign.detached.verify`，两者匹配 |

### P1 严重缺陷（5项）

| # | 问题 | 验证结果 | 证据 |
|---|------|---------|------|
| 6 | `docs/AUDIT.md` 基于已移除代码 | ✅ 已修复 | AUDIT.md 已重写为 Phase 1-4 审计记录 |
| 7 | `docs/ANP.md` 描述的 HTTP API 已不存在 | ✅ 已修复 | ANP.md 已更新为纯 P2P 协议描述 |
| 8 | 私钥明文存储，无文件权限控制 | ✅ 已修复 | `identity.ts` 新增 `fs.chmodSync(identityFile, 0o600)` |
| 9 | 语义搜索退化为哈希碰撞匹配 | ⚠️ 部分修复 | 文档已标注为 SHA-256 确定性嵌入（设计限制），但本质问题未解决 |
| 10 | `ARCHITECTURE.md` 描述的 L2/L3 组件已移除 | ✅ 已修复 | 已重写为纯 P2P 架构 |

### P2 一般缺陷（5项）

| # | 问题 | 验证结果 | 证据 |
|---|------|---------|------|
| 11 | Capability 广播无查询接口 | ⚠️ 设计限制 | 仍为单向广播，文档已标注为设计限制 |
| 12 | DHT shard 检索仅尝试分片 0 | ✅ 已修复 | 已替换为 dual-key DHT 结构（`ann:content:` + `ann:index:`） |
| 13 | `status` 枚举值在 schema 和文档间不一致 | ✅ 已修复 | schema 和文档均统一为 `resolved`, `partial`, `failed` |
| 14 | light 模式仍尝试连接公网 bootstrap | ⚠️ 未完全修复 | `bootstrap` 配置仍存在于 `createLibp2p` 中，light 模式未隔离 |
| 15 | 文档存在大量非技术表述 | ✅ 已修复 | 浮夸表述已移除或替换 |

### 验证报告中的 11 项修复

| # | 问题 | 验证结果 |
|---|------|---------|
| 1 | Gossip 无签名验证 | ✅ 已修复 |
| 2 | package.json 版本不匹配 | ✅ 已修复（2.0.0） |
| 3 | publish 后未写入本地 SQLite | ✅ 已修复 |
| 4 | `estimateNetworkSize` 无文档 | ✅ 已修复（JSDoc 已添加） |
| 5 | `searchSimilarVectors` 注释不准确 | ✅ 已修复 |
| 6 | 私钥文件权限未限制 | ✅ 已修复 |
| 7 | Capability 广播延迟 3 秒 | ✅ 已修复 |
| 8 | 文档描述已移除组件/HTTP API | ✅ 已修复 |
| 9 | `nacl.sign` 误用 | ✅ 已修复 |
| 10 | `client_sim.mjs` 工具名 | ✅ 已修复 |
| 11 | `e2e-federation.mjs` 引用 ann-hub | ✅ 已修复 |

---

## 二、新增发现

### 2.1 代码正确性

#### 新增 1: `encodeErasure` 实现不完整（MUST_FIX）

**位置**: `mcp-server-ann/src/p2p.ts:170-195`

**问题**: `encodeErasure` 函数中 `rsInstance.encode(shards)` 被注释掉，实际未执行 Reed-Solomon 编码。返回的 shards 只是原始数据分片 + 空 parity 分片。

```typescript
// rsInstance.encode(shards);
```

**影响**: 纠删码功能完全未实现，数据冗余和恢复能力为零。`shards.length` 在返回消息中误导用户认为已生成有效分片。

**建议修复**: 
- 解除 `reedsolomon` 库的注释调用
- 或移除该功能并更新文档，声明 Phase 4 分片为占位实现

---

#### 新增 2: `decodeErasure` 实现不正确（MUST_FIX）

**位置**: `mcp-server-ann/src/p2p.ts:197-199`

**问题**: `decodeErasure` 直接返回 `Buffer.concat(shards.slice(0, dataShards))`，未进行任何 Reed-Solomon 解码或损坏检测。

**影响**: 若分片损坏或丢失，无法恢复原始数据。与 `encodeErasure` 配合，整个纠删码系统为假实现。

**建议修复**: 
- 实现完整的 RS 解码逻辑
- 或移除该功能并明确标注为未实现

---

#### 新增 3: `dhtSweepExpired` 为无操作占位（IMPORTANT）

**位置**: `mcp-server-ann/src/p2p.ts:478-485`

**问题**: 函数直接返回 `{ deleted: 0, checked: 0 }`，注释说明 DHT 不支持 key 枚举。

**影响**: 过期 DHT 条目仅能在读取时被动清理，无法主动扫描清理，长期可能导致 DHT 膨胀。

**建议修复**: 
- 在本地 SQLite 中维护已发布 CID 清单
- 或接受此限制并在文档中明确说明

---

#### 新增 4: `runGarbageCollection` 中 `deletedIndexes.changes` 类型安全问题（IMPORTANT）

**位置**: `mcp-server-ann/src/db.ts:58-66`

**问题**: 虽然代码已添加 `deletedIndexes.changes && deletedIndexes.changes > 0` 检查，但 `sqlite` 库的 `RunResult.changes` 类型为 `number | undefined`。当前检查可运行，但 TypeScript strict 模式下可能报错。

**影响**: 运行时安全，但类型定义不够严谨。

**建议修复**: 
- 使用 `(deletedIndexes.changes ?? 0) > 0` 确保类型安全

---

#### 新增 5: `searchSimilarVectors` 中 `expires_at` 过滤与注释不一致（INFO）

**位置**: `mcp-server-ann/src/db.ts:78`

**问题**: 查询使用 `expires_at > ?`（严格大于），但注释说明是 TTL 清理。若 `expires_at == now`，该行不会被 GC 清理（GC 用 `<`），但也不会被搜索返回。

**影响**: 边缘情况，影响极小。

---

### 2.2 协议一致性

#### 新增 6: ANP 签名格式中 `related_cid` 的 null 处理不一致（IMPORTANT）

**位置**: `index.ts:94` vs `p2p.ts:364`

**问题**: 
- `index.ts` 签名生成: `related_cid || null`
- `p2p.ts` 签名验证: `related_cid: payload.related_cid ?? null`

当 `related_cid` 为 `undefined` 时，两者行为一致。但当 `related_cid` 为假值（如空字符串 `""`）时，`||` 和 `??` 行为不同。

**影响**: 若 `related_cid` 为空字符串，签名生成使用 `null`，验证也使用 `null`，实际上一致。但若其他假值如 `0`，`||` 会转为 `null` 而 `??` 不会。

**建议修复**: 
- 统一使用 `?? null` 或明确规范 `related_cid` 只能为 string | null

---

### 2.3 安全

#### 新增 7: `content` 字段未做内容过滤或 XSS 防护（IMPORTANT）

**位置**: `mcp-server-ann/src/index.ts:62-63`

**问题**: `content` 最大允许 1,000,000 字符，但无内容类型检查或危险内容过滤。

**影响**: 恶意节点可发布包含脚本、恶意链接或其他有害内容的知识卡片。

**建议修复**: 
- 添加基本的内容安全过滤（如 HTML 标签转义）
- 或在文档中明确声明内容安全由消费端负责

---

#### 新增 8: `allowPublishToZeroTopicPeers: true` 和 `emitSelf: true` 安全风险（INFO）

**位置**: `mcp-server-ann/src/p2p.ts:40-41`

**问题**: 
- `allowPublishToZeroTopicPeers: true` 允许向零个 peer 发布，不保证传播
- `emitSelf: true` 导致节点接收自己发布的消息，增加数据库写入压力

**影响**: 
- 网络分区时发布可能实际上未传播
- 自接收消息导致不必要的 SQLite INSERT OR IGNORE 操作

**建议修复**: 
- 评估是否可将 `emitSelf` 设为 `false`（需确认本地发布是否依赖此机制）
- 文档说明此行为

---

### 2.4 可靠性

#### 新增 9: `startP2PNode('full')` 并发调用竞争条件（IMPORTANT）

**位置**: `mcp-server-ann/src/index.ts:101, 140`

**问题**: `publish_knowledge` 和 `search_knowledge` 均调用 `await startP2PNode('full')`。虽然 `startP2PNode` 内部有 `if (node) return node` 保护，但首次启动时并发调用可能导致竞争。

**影响**: 两个工具同时首次调用时，可能创建两个 libp2p 实例。

**建议修复**: 
- 在 `startP2PNode` 中添加启动状态锁（Promise 锁或 async-mutex）

---

#### 新增 10: SQLite 无 WAL 模式配置（IMPORTANT）

**位置**: `mcp-server-ann/src/db.ts:12-15`

**问题**: `sqlite3.Database` 未配置 WAL 模式。在高并发写入场景（如同时接收多个 gossip 消息）下，SQLite 的默认 journal 模式可能导致数据库锁定错误。

**影响**: 并发写入时可能出现 `SQLITE_BUSY` 错误。

**建议修复**: 
- 在 `getDb()` 初始化后执行 `await db.exec('PRAGMA journal_mode = WAL;')`

---

#### 新增 11: 进程退出时无显式资源清理（INFO）

**位置**: `mcp-server-ann/src/index.ts:270-280`

**问题**: `main()` 中未注册 `process.on('SIGINT', ...)` 或 `process.on('SIGTERM', ...)` 处理程序来关闭 libp2p 节点和 SQLite 连接。

**影响**: 进程被 kill 时可能导致 SQLite 数据库损坏或 libp2p 连接未优雅关闭。

**建议修复**: 
- 添加信号处理程序进行优雅关闭

---

### 2.5 文档准确性

#### 新增 12: `README.md` 中 "semantic vector search" 表述误导（IMPORTANT）

**位置**: `README.md`

**问题**: README 描述为 "semantic vector search"，但实际使用的是 SHA-256 hash 归一化向量，不具备语义区分能力。

**影响**: 用户预期与实际行为不符。

**建议修复**: 
- 将 "semantic vector search" 改为 "deterministic hash-based similarity search"
- 或明确标注为 demo/fallback 实现

---

#### 新增 13: `ARCHITECTURE.md` 中 "Cosine Similarity" 声明不准确（IMPORTANT）

**位置**: `ARCHITECTURE.md` 和 `db.ts` 注释

**问题**: 文档声明 "Both query and stored vectors are normalized to unit length... cosine similarity equals dot product"。但 SHA-256 hash 字节归一化到 `[-1, 1]` 并不等于单位向量（模长不一定为 1）。

**影响**: 数学声明错误，实际计算的是未归一化点积，不是余弦相似度。

**建议修复**: 
- 修正文档：声明为 "dot product similarity" 而非 "cosine similarity"
- 或在 `generateEmbedding` 中实现真正的 L2 归一化

---

### 2.6 测试覆盖

#### 新增 14: `npm test` 脚本未配置（MUST_FIX）

**位置**: `mcp-server-ann/package.json`

**问题**: 
```json
"test": "echo \"Error: no test specified\" && exit 1"
```

**影响**: CI 无法运行自动化测试，E2E 测试仅为手动脚本。

**建议修复**: 
- 配置测试框架（如 vitest 或 jest）
- 为关键函数（签名验证、DHT 操作、声誉计算）编写单元测试

---

#### 新增 15: E2E 测试不完整（IMPORTANT）

**位置**: `tests/e2e-federation.mjs`

**问题**: 
- 仅测试工具列表和身份生成，未测试实际的 `publish_knowledge` 和 `search_knowledge` 功能
- 未测试签名验证流程
- 未测试 DHT 读写
- 未测试声誉系统

**影响**: 核心功能缺乏自动化回归测试。

**建议修复**: 
- 扩展 E2E 测试覆盖完整发布-搜索流程
- 添加签名验证专项测试

---

## 三、风险评级

### 高风险（MUST_FIX）

| # | 问题 | 影响 |
|---|------|------|
| 1 | `encodeErasure` / `decodeErasure` 为假实现 | 数据冗余和恢复能力为零，误导用户 |
| 2 | `npm test` 未配置 | 无法自动化验证代码正确性 |

### 中风险（IMPORTANT）

| # | 问题 | 影响 |
|---|------|------|
| 3 | `startP2PNode` 并发竞争条件 | 可能创建多个 libp2p 实例 |
| 4 | SQLite 无 WAL 模式 | 并发写入可能失败 |
| 5 | `content` 无内容过滤 | 恶意内容传播风险 |
| 6 | "Cosine Similarity" / "semantic" 文档误导 | 用户预期与实际不符 |
| 7 | `dhtSweepExpired` 无操作 | DHT 长期膨胀 |
| 8 | E2E 测试不完整 | 核心功能无回归测试 |
| 9 | `related_cid` 空值处理不一致 | 边缘情况签名验证可能失败 |

### 低风险（INFO / OPTIONAL）

| # | 问题 | 影响 |
|---|------|------|
| 10 | `emitSelf: true` 自接收消息 | 不必要的 DB 写入 |
| 11 | 进程退出无优雅关闭 | 潜在资源泄漏 |
| 12 | `expires_at` 严格大于过滤 | 边缘情况数据可见性 |
| 13 | light 模式仍连接公网 bootstrap | 已记录为设计限制，但可优化 |

---

## 四、修复建议优先级

### 立即修复（阻塞发布）

1. **修复或移除纠删码实现** — `encodeErasure`/`decodeErasure` 当前为假实现，要么实现完整 RS 编解码，要么移除并在文档中标注为未实现
2. **配置测试框架** — 至少为签名验证、DHT 操作、声誉计算添加单元测试

### 短期修复（1-2 周内）

3. **添加 `startP2PNode` 并发锁** — 防止重复初始化
4. **启用 SQLite WAL 模式** — 提高并发写入可靠性
5. **修正文档中的 "cosine similarity" 和 "semantic" 表述** — 避免误导
6. **扩展 E2E 测试** — 覆盖 publish/search 完整流程

### 中期改进（后续迭代）

7. **实现 `dhtSweepExpired`** — 维护本地 CID 清单以支持主动清理
8. **添加内容安全过滤** — 基本 XSS/恶意内容防护
9. **添加进程信号处理** — 优雅关闭资源
10. **隔离 light 模式 bootstrap 配置** — 避免不必要的公网连接

---

## 五、总体评估

### 修复质量评价

| 维度 | 评分 | 说明 |
|------|------|------|
| P0 缺陷修复 | 优秀 | 所有阻塞性缺陷均已正确修复 |
| P1 缺陷修复 | 良好 | 大部分已修复，语义搜索为设计接受 |
| P2 缺陷修复 | 良好 | 大部分已修复，light 模式 bootstrap 可优化 |
| 文档同步 | 优秀 | 所有文档已与代码同步 |
| 新增代码质量 | 良好 | Phase 1-4 实现逻辑清晰，但存在假实现和并发问题 |

### 与上次审计对比

| 指标 | 上次 | 本次 |
|------|------|------|
| P0 缺陷 | 5 | 2（新增） |
| P1 缺陷 | 5 | 9（新增） |
| P2 缺陷 | 5 | 4（新增） |
| 文档一致性 | 差 | 优秀 |
| 协议一致性 | 差 | 良好 |

### 结论

项目已从"不可测试"状态改善为"可运行但需完善"状态。核心 P0 缺陷已修复，但新增发现表明在可靠性、测试覆盖和实现完整性方面仍有显著差距。**不建议生产部署**，建议完成"立即修复"和"短期修复"项后再进行下一轮审计。

---

*审计方法*: 静态代码分析、文档一致性比对、协议规范验证、构建验证
*审计限制*: 未进行运行时动态分析、未执行模糊测试
*建议复查周期*: 完成本次修复后
