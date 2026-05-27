# ANN 项目独立审计报告 v3（更正版）

**审计日期**: 2026-05-25
**审计范围**: mcp-server-ann/ 全部源码
**方法**: 静态代码分析 + 运行时验证（`npm test`）+ 源码逐行核查
**对照**: AUDIT_REPORT_2026-05-25.md（v2，自我审计）

---

## 一、核心发现：v2 报告存在严重错误

v2 报告为自我审计，存在 **5 项误判**（将已实现功能标记为"MUST_FIX"），需先更正。

### 误判 1（P0 级误判）：纠删码为"假实现" ❌

**v2 结论**: `encodeErasure` 被注释未执行，声称"纠删码功能为零"。

**实测结论**: ✅ 已完整实现，非假实现。

**证据**:
```typescript
// p2p.ts:188-202 — encodeErasure 完整实现
const encoder = new rs.ReedSolomonEncoder(rs.GenericGF.AZTEC_DATA_8());
for (let i = 0; i < shardSize; i++) {
  const message = new Int32Array(messageLength);
  for (let j = 0; j < dataShards; j++) {
    message[j] = paddedBuffer[j * shardSize + i];
  }
  encoder.encode(message, errorCorrectionLength);  // ← 未注释
  for (let j = 0; j < parityShards; j++) {
    parityBuffer[j * shardSize + i] = message[dataShards + j];
  }
}
```

vitest 测试通过：
```
✓ src/__tests__/erasure.test.ts (4 tests)
```

---

### 误判 2（P0 级误判）：`npm test` 未配置 ❌

**v2 结论**: `package.json` 中 test 脚本为 `echo "Error: no test specified" && exit 1`。

**实测结论**: ✅ 已配置 vitest。

**证据**:
```json
// package.json
"test": "vitest run",
"test:coverage": "vitest run --coverage",
"test:perf": "vitest run src/__tests__/perf/ --reporter=verbose",
```

运行结果：
```
Test Files  9 passed | 1 skipped (10)
     Tests  30 passed | 7 skipped (37)
```

---

### 误判 3（P1 级误判）：SQLite 无 WAL 模式 ❌

**v2 结论**: `db.ts` 未配置 WAL，高并发写入会 `SQLITE_BUSY`。

**实测结论**: ✅ WAL 已配置。

**证据** (`db.ts:19`):
```typescript
PRAGMA journal_mode = WAL;
```

perf 测试证实 WAL 已生效：
```json
{
  "test": "sqlite-wal-vs-rollback",
  "walLatencyMs": 47.34,
  "rollbackLatencyMs": 138.14,
  "speedupFactor": 2.92
}
```

---

### 误判 4（P1 级误判）：`startP2PNode` 并发竞争条件 ❌

**v2 结论**: 并发调用可能创建两个 libp2p 实例。

**实测结论**: ✅ 已有 Promise 锁保护。

**证据** (`p2p.ts:16-23`):
```typescript
let node: Libp2p<any> | null = null;
let startPromise: Promise<Libp2p<any>> | null = null;

export async function startP2PNode(mode: NodeMode = 'full'): Promise<Libp2p<any>> {
  if (node) return node;
  if (startPromise) return startPromise;  // ← 第二个并发调用等待同一 Promise
  startPromise = (async () => { ... })();
```

---

### 误判 5（P2 级误判）：`related_cid` 空值处理不一致 ❌

**v2 结论**: `||` 与 `??` 对空字符串行为不同，可能导致签名验证失败。

**实测结论**: ⚠️ 理论边缘情况，实际可接受。

`related_cid` 在实际调用中始终为 `string | null | undefined`，无 `0` 或空字符串场景。此问题实际影响极小。

---

## 二、仍需修复的真实问题

以下问题在 v2 报告中判断正确，或为新发现。

### 问题 A（MUST_FIX）：E2E 测试依赖手动脚本 ❌

**位置**: `tests/e2e-federation.mjs`

**现状**: E2E 测试为独立 `.mjs` 手动脚本，CI 中无自动化 E2E。

```yaml
# .github/workflows/ci.yml — 仅运行 vitest，无 E2E
- run: npm test
```

vitest 覆盖了单元/集成测试（`src/__tests__/`），但 publish→gossip→search 的端到端流程无自动化验证。

**修复方案**:
- 将 `tests/e2e-federation.mjs` 改为 npm script：`"test:e2e": "node tests/e2e-federation.mjs"`
- 在 CI 中增加 `npm run test:e2e` 步骤

---

### 问题 B（IMPORTANT）：`dhtSweepExpired` 无操作占位 ❌

**位置**: `p2p.ts:711-717`

**现状**: 函数直接返回 `{ deleted: 0, checked: 0 }`，DHT 无法主动清理过期条目。

```typescript
export async function dhtSweepExpired(node: Libp2p): Promise<...> {
    // DHT does not support key enumeration
    return { deleted: 0, checked: 0 };
}
```

**影响**: DHT 长期膨胀（过期内键累积）。

**修复方案（二选一）**:
1. 在 SQLite 中维护已发布 CID 清单，扫描清理
2. 在文档中明确标注为"设计限制，不支持主动 GC"

---

### 问题 C（IMPORTANT）：`content` 字段无内容安全过滤 ❌

**位置**: `index.ts:62-63`

**现状**: `content` 最大 1,000,000 字符，无 XSS/恶意内容过滤。

```typescript
content: o.content,  // 直接存储，无过滤
```

**影响**: 恶意节点可发布脚本、恶意链接等内容。

**修复方案**:
- 添加基础过滤：`String(o.content).replace(/<script/gi, '&lt;script')`
- 或在文档中声明内容安全由消费端负责

---

### 问题 D（IMPORTANT）："semantic vector search" 表述误导 ❌

**位置**: `README.md`, `ARCHITECTURE.md`

**现状**: README 声称 "semantic vector search"，但实际使用 SHA-256 哈希，不具备语义区分能力。

```typescript
// db.ts:88 — 注释声称余弦相似度，实际是 SHA-256 哈希
* SHA-256 embedding generator, so raw dot product equals cosine similarity.
```

SHA-256 输出为确定性哈希，不具备语义相似性。代码和文档均声称"cosine similarity"但数学上不成立。

**修复方案**:
- 将 README 中 "semantic vector search" 改为 "deterministic hash-based similarity search"
- 修正 `ARCHITECTURE.md` 中 "cosine similarity" 说法
- 在 `db.ts` 注释中补充说明这是"确定性哈希"而非"语义嵌入"

---

### 问题 E（INFO）：7 个 vitest 测试被跳过 ❌

**位置**: `src/__tests__/mcp.test.ts`（全部 7 个测试 skipped）

```bash
↓ src/__tests__/mcp.test.ts (7 tests | 7 skipped)
```

**修复方案**: 检查被跳过的测试原因（`describe.skip` 或 `it.skip`），如无充分理由应恢复。

---

### 问题 F（INFO）：`emitSelf: true` 增加写入压力 ❌

**位置**: `p2p.ts:36`

**现状**: `emitSelf: true` 导致节点接收自己发布的消息，触发不必要的 `INSERT OR IGNORE`。

**影响**: 在高频发布场景下产生额外 SQLite 写入。

**修复方案**: 
- 如本地发布不依赖自接收机制，改为 `emitSelf: false`
- 如依赖，明确注释原因

---

### 问题 G（INFO）：进程退出无显式清理 ❌

**位置**: `index.ts:270-280`

**现状**: 未注册 `SIGINT`/`SIGTERM` 处理。

**修复方案**:
```typescript
process.on('SIGINT', async () => {
  console.log('[ANN] Shutting down...');
  await node.stop();
  db.close();
  process.exit(0);
});
```

---

## 三、风险评级（更正后）

### 高风险（MUST_FIX）

| # | 问题 | 说明 |
|---|------|------|
| A | E2E 测试未自动化 | CI 无法验证核心发布-搜索流程 |

### 中风险（IMPORTANT）

| # | 问题 | 说明 |
|---|------|------|
| B | `dhtSweepExpired` 无操作 | DHT 长期膨胀 |
| C | `content` 无内容过滤 | 恶意内容传播风险 |
| D | "semantic"/"cosine" 文档误导 | 用户预期与实际不符 |

### 低风险（INFO）

| # | 问题 | 说明 |
|---|------|------|
| E | 7 个 mcp.test.ts 跳过 | 应调查原因或恢复 |
| F | `emitSelf: true` | 额外 DB 写入 |
| G | 无进程信号处理 | 优雅关闭缺失 |

---

## 四、修复建议

### 立即修复

**1. 将 E2E 脚本接入 CI（问题 A）**

```yaml
# .github/workflows/ci.yml — 添加 e2e 步骤
- name: Run E2E tests
  run: npm run test:e2e
  env:
    NODE_ENV: test
```

```json
// package.json — 添加 script
"test:e2e": "node tests/e2e-federation.mjs"
```

### 短期修复（1 周内）

**2. 修正文档表述（问题 D）**
- `README.md`: "semantic vector search" → "deterministic hash-based similarity search"
- `ARCHITECTURE.md`: 删除"cosine similarity"错误声明
- `db.ts:88`: 补充 SHA-256 确定性嵌入的说明

**3. 调查并恢复跳过的测试（问题 E）**
```bash
# 查看跳过原因
grep -n "skip\|todo\|only" src/__tests__/mcp.test.ts
```

**4. 添加内容安全注释或过滤（问题 C）**
在 `publish_knowledge` 中添加注释说明内容安全由消费端负责。

### 中期改进

**5. 实现 `dhtSweepExpired`（问题 B）**

方案 A（维护本地 CID 清单）:
```typescript
// 每次 publish 时记录 CID
await db.run('INSERT INTO published_cids (cid, published_at) VALUES (?, ?)', cid, now);

// GC 时扫描
export async function dhtSweepExpired(node: Libp2p) {
  const stale = await db.all(
    'SELECT cid FROM published_cids WHERE published_at < ?', 
    now - TTL
  );
  for (const { cid } of stale) {
    await node.contentRouting.remove(cid);
    await db.run('DELETE FROM published_cids WHERE cid = ?', cid);
  }
}
```

方案 B（接受限制，文档标注）

**6. 添加进程信号处理（问题 G）**

---

## 五、与 v2 报告对比

| 项目 | v2 报告 | 本次审计 | 说明 |
|------|---------|---------|------|
| 纠删码 | MUST_FIX（假实现） | ✅ 已实现 | v2 误判 |
| npm test | MUST_FIX（未配置） | ✅ 已配置 | v2 误判 |
| SQLite WAL | IMPORTANT（未配置） | ✅ 已配置 | v2 误判 |
| startP2PNode 并发 | IMPORTANT（有竞争） | ✅ 已防护 | v2 误判 |
| related_cid | INFO（不一致） | ⚠️ 边缘情况 | v2 误判，v2 过度解读 |
| E2E 测试 | IMPORTANT（不完整） | ✅ MUST_FIX | v2 判断正确，降级为高风险 |
| dhtSweepExpired | IMPORTANT | ✅ 确认 | v2 判断正确 |
| content 过滤 | IMPORTANT | ✅ 确认 | v2 判断正确 |
| 文档误导 | IMPORTANT | ✅ 确认 | v2 判断正确 |
| 进程清理 | INFO | ✅ 确认 | v2 判断正确 |

**v2 报告总体质量**: 自我审计存在系统性误判（将已实现功能标记为严重缺陷）。建议引入外部审计。核心发现（E2E 未自动化、文档误导、无主动 GC）仍有价值。

---

## 六、总结

**代码质量**: 良好。核心功能（签名验证、DHT、P2P、纠删码）均有完整实现，vitest 测试通过率 81%（30/37，含 7 个跳过）。

**主要风险**: E2E 流程无 CI 自动化验证，文档存在"semantic search"等误导性表述，DHT 无主动 GC 机制。

**建议**: 修复 E2E 自动化（高优先级）→ 修正文档表述（短期）→ 调查跳过测试（短期）→ 评估 dhtSweepExpired 方案（中期）。

---

*审计工具: 静态分析（grep/sed/cat）+ npm test 运行时验证 + 源码逐行核查*
*审计限制: 未进行模糊测试、未执行 P2P 网络级测试、未进行安全渗透测试*
