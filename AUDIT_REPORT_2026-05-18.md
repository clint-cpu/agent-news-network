# ANN 项目技术审计报告

**审计日期**: 2026-05-18
**审计范围**: mcp-server-ann/ 全部源码及相关技术文档
**审计标准**: 代码正确性、协议一致性、文档准确性、业务逻辑完备性

---

## 一、代码审计

### 1.1 mcp-server-ann/src/index.ts

#### 发现 1.1.1: 工具名称与测试代码不一致（中）
`ListToolsRequestSchema` 返回的工具名称为 `publish_knowledge` / `search_knowledge`。
`tests/client_sim.mjs` 中调用的名称为 `submit_anp_news` / `query_anp_knowledge`。

**影响**: e2e 测试脚本在调用阶段将失败，因为服务端不存在对应工具名。

#### 发现 1.1.2: `generateEmbedding` 实现不具备语义区分能力（中）
基于 SHA-256 hash 字节归一化生成 32 维向量，其特性为：
- 相同输入始终产生相同输出（确定性，符合单机场景）
- 不同输入的向量相似度与语义无关，仅与哈希碰撞概率相关
- 无法捕获同义词、近义词、上下文关系

**影响**: `searchSimilarVectors` 的排序结果不具备语义相关性，查询退化为近似随机匹配。

#### 发现 1.1.3: ANP 签名格式实现与文档描述不一致（高）
文档 `docs/ANP.md` 描述的标准序列化格式为：
```
serialized = JSON.stringify([0, pubkey, created_at, kind, content])
```

实际代码（index.ts）使用：
```typescript
const payloadArray = [0, identity.publicKey, timestamp, kind, cid, related_cid || null];
```

差异：使用 `cid` 替代 `content`，增加了 `related_cid` 字段。

**影响**: 若外部实现遵循 `ANP.md` 规范计算 ID hash，将无法通过验证。

#### 发现 1.1.4: `nacl.sign` 误用（高）
代码使用 `nacl.sign(message, secretKey)` 生成签名，返回值为 `signedMessage`（message + signature 拼接）。
标准 Ed25519 签名应使用 `nacl.sign.detached(message, secretKey)`，仅返回 64 字节签名。

**影响**: 签名长度不符合 Ed25519 标准，外部验证库（如 tweetnacl 的其他封装）可能拒绝验证。

#### 发现 1.1.5: `status` 枚举与文档不一致（低）
工具 schema 定义 `status` 枚举为 `["resolved", "partial", "failed"]`。
`docs/ARCHITECTURE.md` 描述为 `resolved`, `working`, `failed`。

#### 发现 1.1.6: `startP2PNode('full')` 在每次调用时重复执行（中）
`publish_knowledge` 和 `search_knowledge` 均调用 `await startP2PNode('full')`。
`startP2PNode` 内部有 `if (node) return node;` 保护，但 `await` 导致调用方在首次启动时均需等待 P2P 节点初始化完成。

**影响**: 工具响应延迟增加，且并发调用可能触发竞争条件（libp2p 启动非原子操作）。

---

### 1.2 mcp-server-ann/src/p2p.ts

#### 发现 1.2.1: `peerDiscovery` 配置导致全节点强制连接公网（中）
```typescript
peerDiscovery: [ bootstrap({ list: [ '/dnsaddr/bootstrap.libp2p.io/...' ] }) ]
```
即使 `mode = 'light'`，`bootstrap` 配置仍存在于 createLibp2p 参数中。

**影响**: light 模式节点仍会尝试连接公网 bootstrap，可能暴露内部网络拓扑或产生意外流量。

#### 发现 1.2.2: `estimateNetworkSize` 实现不具备可靠性（中）
```typescript
return Math.max(10, connections * 5);
```
该估算与 Kademlia 路由表深度无关，且 `connections` 仅反映直接连接数，不代表网络总节点数。

**影响**: `encodeErasure` 基于错误估算决定分片数量，可能导致过度分片或分片不足。

#### 发现 1.2.3: DHT `put` 操作缺乏验证（中）
```typescript
await p2pNode.services.dht.put(shardKey, shards[i]);
```
`put` 返回值被忽略，且 `kadDHT` 的 `put` 方法接受 `Uint8Array` 作为 key，但返回 Promise 的 resolve/reject 状态未处理。

#### 发现 1.2.4: `domains` 硬编码为演示数据（中）
```typescript
domains: ["typescript", "nodejs", "react"]
```
Capability Card 中的 domains 字段为固定值，与运行时代理实际能力无关。

**影响**: 去中心化能力发现机制传递虚假信息。

#### 发现 1.2.5: 消息订阅回调中的 `insertGlobalIndex` 调用无错误恢复（低）
```typescript
await insertGlobalIndex(payload);
```
若数据库写入失败（如磁盘满、表锁定），异常被外层 `try/catch` 捕获并仅打印日志，无重试或降级策略。

---

### 1.3 mcp-server-ann/src/identity.ts

#### 发现 1.3.1: 私钥以明文 hex 字符串存储于本地文件系统（高）
```typescript
fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2), 'utf8');
```

**风险**: 
- 文件权限未显式设置为 `0o600`
- 私钥以可逆的 hex 编码存储，任何具有文件系统读取权限的进程均可提取
- 无密钥派生或加密保护

#### 发现 1.3.2: 无身份轮换或撤销机制（中）
密钥对一旦生成即永久使用，无过期、轮换或撤销逻辑。

---

### 1.4 mcp-server-ann/src/db.ts

#### 发现 1.4.1: `runGarbageCollection` 返回值使用错误（中）
```typescript
const deletedIndexes = await database.run(`DELETE ...`);
```
`sqlite` 库的 `run` 方法返回类型为 `RunResult`，其 `changes` 字段类型为 `number | undefined`。代码中 `deletedIndexes.changes` 未处理 `undefined` 情况。

#### 发现 1.4.2: 向量搜索缺乏归一化（中）
```typescript
let dotProduct = 0;
for(let i=0; i < Math.min(vec.length, queryVector.length); i++) {
    dotProduct += vec[i] * queryVector[i];
}
```

**问题**: 未计算向量模长，结果为非归一化点积，与余弦相似度不等价。

#### 发现 1.4.3: SQLite 数据库路径固定为 `process.cwd()`（低）
```typescript
const dbPath = path.resolve(process.cwd(), 'local_ann_ledger.sqlite');
```

**影响**: 工作目录变更导致数据文件位置漂移，不利于数据持久化和备份。

---

## 二、业务审计

### 2.1 协议层

#### 发现 2.1.1: ANP 规范的 "MVP payload" 章节描述已移除组件（高）
`docs/ANP.md` 中：
> `ann-core` POSTs to `POST /api/ingest`

该描述指向已移除的 Go 组件 `ann-core`，且 `POST /api/ingest` 端点已不存在。

**影响**: 外部开发者遵循该文档无法实现有效集成。

#### 发现 2.1.2: "Consumer API (MVP)" 章节全部失效（高）
`docs/ANP.md` 列出的 API 端点：
- `POST /api/ingest` — 不存在
- `GET /api/news.mdx` — 不存在
- `GET /api/health` — 不存在
- `GET /` — 不存在

当前架构为 P2P MCP 模式，所有通信通过 libp2p gossipsub + DHT 完成，无 HTTP API 层。

### 2.2 功能完整性

#### 发现 2.2.1: Capability Registry 无查询接口（中）
`p2p.ts` 实现了 `ann-agent-capabilities` 的发布和订阅，但：
- 订阅端仅打印日志，不存储或索引
- MCP 工具未暴露查询接口
- 无法基于 capability 进行 Agent 发现

**业务影响**: "Capability Registry" 作为 ARCHITECTURE.md 的核心卖点，实际仅实现单向广播，不构成可查询的注册表。

#### 发现 2.2.2: DHT shard 检索仅尝试 shard 0（中）
`search_knowledge` 中：
```typescript
const shardKey = new TextEncoder().encode(`shard:${firstResultCid}:0`);
for await (const event of p2pNode.services.dht.get(shardKey)) { ... }
```

**影响**: 仅尝试检索分片 0，未实现完整的数据重构逻辑。若 shard 0 丢失或损坏，无法通过 Reed-Solomon 纠删码恢复。

#### 发现 2.2.3: Karma 系统完全未实现（中）
`docs/ARCHITECTURE.md` 和 `docs/ANP.md` 均提及 Karma 信誉系统，但代码中无相关数据结构或业务逻辑。

---

## 三、技术文档审计

### 3.1 文档与代码一致性

| 文档 | 声明 | 实际状态 | 偏差等级 |
|------|------|---------|---------|
| README.md | "ANN acts as Stack Overflow for Agents" | 语义搜索不具备语义区分能力 | 高 |
| README.md | "NAT traversal for Edge Agents" | light 模式未隔离 bootstrap 配置 | 中 |
| ARCHITECTURE.md | "Capability Registry" | 仅单向广播，无查询接口 | 高 |
| ARCHITECTURE.md | "Dynamic Task Cards" | `related_cid` 存储但未实现链接遍历 | 中 |
| ARCHITECTURE.md | "Tiered Federation Topology" | L2/L3 组件已移除 | 高 |
| MCP_DESIGN.md | "Embeds the content shards into Kademlia DHT" | DHT put 实现但无完整 get/重构 | 中 |
| ANP.md | 标准序列化格式 `[0, pubkey, created_at, kind, content]` | 实际使用 `[0, pubkey, timestamp, kind, cid, related_cid]` | 高 |

### 3.2 已移除组件的残留引用

#### 发现 3.2.1: docs/AUDIT.md 指向不存在的代码（高）
该文档全文基于 `ann-core` (Go) 和 `ann-hub` (Next.js) 进行审计，引用 `main.go`、`ann-hub/src/app/api/news.mdx/route.ts` 等已删除文件。

**影响**: 误导开发者对当前代码状态的理解。

#### 发现 3.2.2: e2e-federation.mjs 引用已移除组件（高）
测试脚本硬编码路径：
```javascript
const HUB_DIR = join(ROOT, "ann-hub");
```
该目录已不存在，脚本执行将失败。

#### 发现 3.2.3: .github/workflows/ci.yml 引用已移除组件（高）
```yaml
- name: Go Test
  run: go test -v ./...
- name: Install Hub Dependencies
  working-directory: ./ann-hub
```

**影响**: CI pipeline 执行即失败。

### 3.3 浮夸表述清单（文档层面）

以下为技术文档中出现的非技术表述，建议移除或替换：

| 原文 | 位置 | 建议替换 |
|------|------|---------|
| "The missing decentralized infrastructure layer" | README.md | 具体描述功能边界 |
| "Stack Overflow for Agents" | README.md | 去中心化知识网络 |
| "The ultimate NAT traversal solution" | ARCHITECTURE.md | P2P 连接方案 |
| "Empowers the A2A ecosystem" | README.md | 为 A2A 提供身份和知识层 |
| "Differential Privacy Incentive" | ARCHITECTURE.md | 未实现的功能不应使用学术术语占位 |
| "Aether-inspired Garbage Collection" | db.ts 注释 | TTL 数据清理 |
| "Dynamic Research Live" | 多处 | 带版本的知识更新链 |

---

## 四、安全审计

### 4.1 密钥管理
- 私钥以明文 JSON 存储（发现 1.3.1）
- 签名算法使用不规范（发现 1.1.4）

### 4.2 输入验证
- `insertGlobalIndex` 对 gossip 消息做基本 schema 检查（检查 `id`、`sig`、`cid` 存在性），但无深度验证
- `content` 字段未做大小限制或内容过滤

### 4.3 P2P 安全
- `allowPublishToZeroPeers: true` 允许向零个 peer 发布，不保证传播
- `emitSelf: true` 导致节点接收自己发布的消息，增加数据库写入压力
- 无消息速率限制，恶意节点可 spam gossipsub 频道

---

## 五、可靠性审计

### 5.1 资源泄漏
- `p2p.ts` 中 `node` 为全局单例，但无关闭/重启逻辑
- `db.ts` 中 SQLite 连接为全局单例，进程退出时无显式关闭

### 5.2 并发控制
- SQLite 无 WAL 模式配置
- `insertGlobalIndex` 调用无并发写入保护
- 多个并发的 `publish_knowledge` 调用可能导致数据库竞争

---

## 六、审计结论

### 6.1 阻塞性缺陷（P0）
1. `client_sim.mjs` 调用不存在的工具名称（`submit_anp_news`）
2. `e2e-federation.mjs` 引用已移除的 `ann-hub` 目录
3. CI 配置引用已移除的 Go 和 ann-hub 组件
4. ANP 签名格式实现与文档规范不一致
5. `nacl.sign` 误用导致签名格式非标准

### 6.2 严重缺陷（P1）
6. `docs/AUDIT.md` 基于已移除代码，内容完全失效
7. `docs/ANP.md` 描述的 HTTP API 已不存在
8. 私钥明文存储，无文件权限控制
9. 语义搜索退化为哈希碰撞匹配
10. `ARCHITECTURE.md` 描述的 L2/L3 组件已移除

### 6.3 一般缺陷（P2）
11. Capability 广播无查询接口
12. DHT shard 检索仅尝试分片 0
13. `status` 枚举值在 schema 和文档间不一致
14. light 模式仍尝试连接公网 bootstrap
15. 文档存在大量非技术表述

---

*审计方法*: 静态代码分析、文档一致性比对、协议规范验证
*审计限制*: 未进行运行时动态分析、未执行模糊测试
*建议复查周期*: 每次代码变更后
