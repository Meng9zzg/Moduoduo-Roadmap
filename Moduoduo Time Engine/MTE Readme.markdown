# Moduoduo Time Engine (MTE)

**版本**：`v0.1.0-beta-20260221` · **语言**：TypeScript · **依赖**：`chrono-node`（唯一外部依赖）  
**时区**：全局固定深圳时间 `UTC+8`（IANA 键名 `Asia/Shanghai`，深圳/北京/广州同区）

> 为中文 RAG 系统提供时间感知能力的轻量处理层。零 LLM 调用，零额外延迟，中文语义特化。

---

## 是什么

MTE 是一个单文件 TypeScript 模块，解决大模型在时间处理上的三类核心问题：

- **时间幻觉**：模型把"今年"理解成训练截止年份，而不是真实当前年份
- **意图混淆**：分不清用户是在"查历史知识"还是"查实时动态"，导致错误路由
- **日期解析盲区**：中文节日名称、口语模糊词（"前一阵""大前天"）无法被通用库识别

---

## 架构总览

```
用户问题
   │
   ├─► detectTimeIntent()   → 意图分类（knowledge / realtime / mixed）
   │         │
   │         └─► searchQuery（附时间后缀的增强搜索词）
   │
   ├─► injectTimeContext()  → 注入时间上下文到用户消息
   │         │
   │         ├─► timePrompt(clock)   → 写入 System Prompt 时间规则段落
   │         └─► now(clock)          → 替换"今年/本年/今年度"为具体年份
   │
   └─► isWithinWindow()    → 过滤检索结果中超出时间窗口的内容
             │
             └─► parseDate()  → 三层解析 fallback
```

---

## 核心功能

| 函数 | 作用 |
|------|------|
| `now(clock?)` | 唯一时间源，固定深圳时间（UTC+8），返回结构化的日期信息 |
| `timePrompt(clock?)` | 生成注入到 System Prompt 的时间规则段落，约束模型的时间基准 |
| `detectTimeIntent(msg)` | 判断用户问题的时间意图：`knowledge` / `realtime` / `mixed` |
| `parseDate(text, clock?)` | 三层 fallback 解析中文时间表达，返回 `Date` 或 `null` |
| `isWithinWindow(text, days, clock?)` | 判断文本中的日期是否在指定天数窗口内 |
| `noResultSignal(clock?)` | 搜索无结果时生成告知 Prompt，防止模型编造近期动态 |

---

## 快速上手

### 安装依赖

```bash
npm install chrono-node
# 或
pnpm add chrono-node
```

### 基本用法

```typescript
import { now, timePrompt, detectTimeIntent, parseDate, isWithinWindow } from "./moduoduo-time-engine";

// 获取当前时间（深圳时间 UTC+8）
const t = now();
console.log(t.dateStr);      // "2026年2月20日"
console.log(t.year);         // 2026
console.log(t.searchSuffix); // "2026年2月"

// 生成注入 System Prompt 的时间段落
const systemPrompt = `你是一个助手。\n\n${timePrompt()}`;

// 检测用户意图
const intent = detectTimeIntent("妈祖最近有什么活动？");
// → { type: "mixed", freshnessDays: 90, searchQuery: "妈祖最近有什么活动？ 2026年2月" }

const intent2 = detectTimeIntent("皮影戏百年历史介绍");
// → { type: "knowledge", freshnessDays: 180, searchQuery: "皮影戏百年历史介绍" }

// 解析中文日期
const date = parseDate("妈祖诞辰前后");   // → Date 对象（对应当年农历三月廿三）
const date2 = parseDate("大前天");        // → 3天前的 Date 对象

// 鲜度过滤
isWithinWindow("2026年2月的演出", 30);   // → true
isWithinWindow("2020年的演出", 30);      // → false
```

### 在 RAG 管道中使用

```typescript
import { detectTimeIntent, timePrompt, now } from "./moduoduo-time-engine";

async function handleQuery(userMessage: string) {
  // 1. 统一时间基准（同一请求内共享）
  const ref = new Date();
  const clock = () => ref;

  // 2. 检测意图，决定路由
  const intent = detectTimeIntent(userMessage);

  if (intent.type === "knowledge") {
    return await queryKnowledgeBase(userMessage);
  }
  if (intent.type === "realtime") {
    // 使用增强后的搜索词（已附加时间后缀）
    return await webSearch(intent.searchQuery);
  }
  if (intent.type === "mixed") {
    const [kb, web] = await Promise.all([
      queryKnowledgeBase(userMessage),
      webSearch(intent.searchQuery),
    ]);
    return merge(kb, web);
  }
}

// 3. 注入时间上下文到用户消息
function buildUserMessage(question: string): string {
  const ref = new Date();
  const clock = () => ref;
  const { year } = now(clock);

  const normalized = question
    .replace(/今年度/g, `${year}年`)
    .replace(/今年/g, `${year}年`)
    .replace(/本年(?!代|度)/g, `${year}年`);

  return `${timePrompt(clock)}\n\n用户问题：${normalized}`;
}
```

---

## 模块详解

### 1. `now(clock?)` — 唯一时间源

```typescript
export function now(clock?: () => Date): TimeNow
```

返回一个 `TimeNow` 对象，包含当前时间的各维度信息：

| 字段 | 类型 | 示例 | 用途 |
|------|------|------|------|
| `year` | number | `2026` | 替换"今年"代词 |
| `month` | number | `2` | 构建搜索词 |
| `day` | number | `20` | 构建日期字符串 |
| `hour` | number | `14` | 判断时段 |
| `weekday` | string | `"星期五"` | 注入 Prompt |
| `dateStr` | string | `"2026年2月20日"` | 显示用 |
| `isoDate` | string | `"2026-02-20"` | 计算用 |
| `searchSuffix` | string | `"2026年2月"` | 拼接搜索词 |

**关键设计**：使用 `Intl.DateTimeFormat("zh-CN").formatToParts()` 而不是直接 `.format()`，避免 zh-CN locale 把年份格式化为 `"2026年"`（含汉字）导致 `+` 转换时 NaN 的 bug。

---

### 2. `timePrompt(clock?)` — 时间规则段落

```typescript
export function timePrompt(clock?: () => Date): string
```

生成注入到 System Prompt 的时间规则文本，指导模型：

- 以当前日期为基准处理时间词
- 知识库中无当年数据时，明确告知用户而不是用历史数据替代
- 禁止在回答中暴露系统时间元信息

每次请求动态生成，不缓存。

---

### 3. `detectTimeIntent(message)` — 意图检测

```typescript
export function detectTimeIntent(message: string): TimeIntent
```

返回：

```typescript
interface TimeIntent {
  type: "knowledge" | "realtime" | "mixed";
  freshnessDays: number;   // 建议的鲜度窗口（天）
  searchQuery: string;     // 附加时间后缀的增强搜索词
}
```

**判定逻辑**（优先级从高到低）：

| 条件 | 结果 | 示例 |
|------|------|------|
| 含知识覆盖词（"年历史"、"起源"等） | `knowledge` | "皮影戏百年历史" |
| 含独立实时词（"天气"、"新闻"） | `realtime` (1天) | "今天天气怎么样" |
| 含时间词 + 知识领域词 | `mixed` | "妈祖最近有什么活动" |
| 含时间词，无知识领域词 | `realtime` | "最近有什么演出" |
| 无时间词 | `knowledge` | "皮影戏是什么" |

**鲜度天数映射**（多词命中取最大值）：

| 时间词 | 鲜度天数 |
|--------|----------|
| 今天、今日、现在 | 1 天 |
| 昨天、明天 | 2 天 |
| 本周、这周 | 7 天 |
| 本月、这月 | 30 天 |
| 最近、近期 | 90 天 |
| 最新 | 180 天 |

**搜索词时间后缀粒度**（根据鲜度自动调整）：

| 鲜度窗口 | 后缀示例 |
|----------|----------|
| ≤ 3 天 | `"2026年2月20日"` |
| ≤ 14 天 | `"2026年2月"` |
| \> 14 天 | `"2026年2月"` |

#### 判定流程图（五道关卡，顺序过滤）

```
用户消息进来
    │
    ▼
① 空消息 → 直接返回 knowledge（默认值）
    │
    ▼
② 含知识覆盖词？（"百年历史""起源""传说"等）
   → 是 → 强制返回 knowledge（"最近百年历史"不算实时）
    │
    ▼
③ 含独立实时词？（"天气""新闻"）
   → 是 → 直接返回 realtime，鲜度=1天（不需要时间词）
    │
    ▼
④ 含时间词吗？（"最近""本周""今天"等）
   → 否 → 返回 knowledge（没提时间=查知识）
   → 是 → 记录最大鲜度天数，进入第五关
    │
    ▼
⑤ 同时含知识领域词？（"皮影""妈祖""非遗"等）
   → 是 → 返回 mixed（联网 + 知识库都查）
   → 否 → 返回 realtime（纯联网搜索）
```

#### 示例演练

**例 1："妈祖最近有什么活动？"**

| 关卡 | 检测结果 |
|------|---------|
| ② 知识覆盖词 | 无 → 继续 |
| ③ 独立实时词 | 无 → 继续 |
| ④ 时间词 | 命中"最近" → `freshnessDays = 90` |
| ⑤ 知识领域词 | 命中"妈祖" → `type = mixed` |

返回结果：

```typescript
{ type: "mixed", freshnessDays: 90, searchQuery: "妈祖最近有什么活动？ 2026年2月" }
```

**例 2："皮影戏百年历史介绍"**

| 关卡 | 检测结果 |
|------|---------|
| ② 知识覆盖词 | 命中"百年" → **立即返回 knowledge，后续全跳过** |

返回结果：

```typescript
{ type: "knowledge", freshnessDays: 180, searchQuery: "皮影戏百年历史介绍" }
```

> 这就是"知识覆盖"的意义：防止"百年"被误认为时间词而触发联网搜索。

---

### 4. `parseDate(text, clock?)` — 三层日期解析

```typescript
export function parseDate(text: string, clock?: () => Date): Date | null
```

三层 fallback，按优先级顺序执行：

```
第一层：FESTIVAL_TABLE 节日查表
   ↓ 未命中
第二层：chrono-node 简体中文解析
   ↓ 未命中
第三层：COLLOQUIAL_OFFSETS 口语偏移词
   ↓ 未命中
   → 返回 null
```

#### 第一层：节日查表

内置 `FESTIVAL_TABLE`，覆盖 2024–2035 年，共 11 个节日：

| 节日 | 农历日期 | 备注 |
|------|----------|------|
| 春节 | 正月初一 | |
| 元宵节 | 正月十五 | |
| 妈祖诞辰 | 三月廿三 | 日期已逐年核实（nongli114.com） |
| 妈祖升天 | 九月初九 | 与重阳节同日，非笔误 |
| 端午节 | 五月初五 | |
| 中秋节 | 八月十五 | |
| 重阳节 | 九月初九 | 与妈祖升天同日，非笔误 |
| 清明节 | — | 节气，约4月4-5日 |
| 元旦 | — | 固定1月1日 |
| 劳动节 | — | 固定5月1日 |
| 国庆节 | — | 固定10月1日 |

查表逻辑：优先匹配当年 → 退回上年 → 取表中最后一条。年份提取使用 `Intl.DateTimeFormat formatToParts` 确保时区正确。

#### 第二层：chrono-node（简体中文）

使用 `chrono.zh.hans.parseDate()`，覆盖：
- 绝对日期：`"2026年2月12日"`、`"2月12号"`
- 相对表达：`"昨天"`、`"上周三"`、`"3天前"`、`"下个月"`
- 时间点：`"今晚8点"`、`"明天下午"`

#### 第三层：口语模糊词

覆盖 chrono 不支持的中文口语，转换为相对天数偏移：

| 口语词 | 偏移天数 |
|--------|----------|
| 前天 | -2 天 |
| 大前天 | -3 天 |
| 大后天 | +3 天 |
| 前一阵、前阵子、前段时间 | -30 天 |
| 不久前、没多久前 | -7 天 |
| 这几天、这两天 | -3 天 |
| 这阵子、这段时间 | -14 天 |
| 上上周 | -14 天 |
| 上上个月 | -60 天 |

---

### 5. `isWithinWindow(text, maxDays?, clock?)` — 鲜度判断

```typescript
export function isWithinWindow(
  text: string,
  maxDays?: number,        // 默认 180 天
  clock?: () => Date
): boolean
```

判断文本中的日期是否在 `maxDays` 天内。**无法解析时返回 `true`**（宁可放行，不漏掉内容）。

**关键实现细节**：`clock()` 只调用一次，`parseDate` 和 `diffMs` 计算共享同一个 `ref`，消除同一请求内跨秒不一致的可能。

---

### 6. `noResultSignal(clock?)` — 无结果信号

```typescript
export function noResultSignal(clock?: () => Date): string
```

当联网搜索无结果时，注入此文本到 Prompt，告知模型不要编造近期动态。

---

## Injectable Clock 设计

所有函数均接受可选的 `clock: () => Date` 参数：

```typescript
// 生产环境（默认）
now()                      // 使用 new Date()

// 同一请求链路内统一时间源（跨日边界安全）
const ref = new Date();
const clock = () => ref;
now(clock);
timePrompt(clock);
isWithinWindow(text, 30, clock);

// 测试环境（mock 指定时间）
const fixedClock = () => new Date("2026-02-20T12:00:00+08:00");
now(fixedClock);
```

这个设计保证：
- **同一请求内**，`now()`、`timePrompt()`、`isWithinWindow()` 使用同一时间点，不受跨秒/跨日边界影响
- **测试时**，可以 mock 任意时间，不依赖系统时钟

---

## 与 RAG 管道的集成点

```
aliyunBailianService.ts
└── injectTimeContext(question)
    ├── now(clock)         → 获取当前年份，替换"今年"代词
    └── timePrompt(clock)  → 生成时间规则段落，写入用户消息头部
```

> 注意：百炼 App API 会忽略 `system` role，因此时间上下文写在 `user` 消息头部，而非 System Prompt。

---

## 与业界方案的对比分析

> 本节基于对 LangChain、LlamaIndex、学术界 Temporal RAG 论文及主流中文 NLP 库的横向调研。

### 功能模块独特性矩阵

| 本引擎功能 | 业界现成方案 | 独特性评估 |
|-----------|-------------|-----------|
| `timePrompt()` 时间注入 | 工程界公认最佳实践，LangChain / LlamaIndex 均有类似实现 | 通用实践，无显著差异 |
| `isWithinWindow()` 鲜度过滤 | LangChain Retriever 的 `time_filter`、LlamaIndex 的 `TimeWeightedVectorStore` | 思路相同，实现各有侧重 |
| `parseDate()` 日期解析 | 有专门库（chrono-node、dateparser、Natty）比纯手写更全面 | 已通过引入 chrono-node 补齐，加自定义层增强中文口语 |
| `detectTimeIntent()` 意图分类 | **全网找不到现成的中文版等价实现** | **原创护城河，核心差异点** |

### `detectTimeIntent()` — 原创优势

学术界处理 Temporal RAG 的顶级论文（TempRALM、RASTeR、T-GRAG）均存在局限：全部基于英文语料，无中文时间语义词表，无可用开源代码，不做"知识词覆盖实时词"的语义优先级逻辑。

LangChain Query Router 最接近，但：

1. **需要调用一次 LLM 才能分类** — 增加延迟（约 0.5-2s）和费用
2. **没有中文时间语义词表** — 不理解"本周末""最近""当前"的鲜度含义
3. **不做知识覆盖逻辑** — 无法区分"皮影戏最近100年历史"（知识类）vs"皮影戏最近有什么演出"（实时类）

MTE 的核心优势：

```
纯规则 + 词表 → 零 LLM 调用 → 零额外延迟 → 零额外费用
中文语义特化 → 鲜度天数精确映射 → 知识/实时/混合 三分类
```

### `parseDate()` — 三层架构的差异化

| 层级 | 解决的问题 | 纯用 chrono-node 的表现 |
|------|-----------|----------------------|
| 第一层：节日查表 | "妈祖诞辰""春节前后"等节日词 | 无法识别，返回 null |
| 第二层：chrono-node | 标准时间表达 | 正确，已是业界最优解 |
| 第三层：口语偏移词 | "前一阵""大前天""这阵子" | 无法识别，返回 null |

### 当前与顶级方案的差距（诚实评估）

| 差距项 | 对本项目场景的影响 | 优先级建议 |
|--------|-----------------|-----------|
| **节日/农历精度** | 节日查表覆盖 2024-2035，2035年后失效 | 中（2035年到期再补充） |
| **具体星期几** | "下周三的演出安排"类查询解析精度受限 | 低（chrono 已部分覆盖） |
| **日期范围** | "活动持续到X月X日"无法提取结束日期 | 中（可扩展 parseDate） |
| **时间点（时:分）** | "晚上8点开幕的演出"降级为日期精度 | 低（鲜度判断不需要时分精度） |
| **单句多时间段** | "从上周到下周的活动"只识别第一个时间词 | 中（可扩展返回 Date[]） |
| **歧义消解** | "三月活动"在不明年份时依赖当年默认 | 低（clock 注入已缓解） |

---

## 适用场景

- 中文垂直领域 RAG 系统（文旅、非遗、政务、媒体等）
- 需要区分"查知识库"和"联网搜索"的智能路由
- 需要防止大模型时间幻觉的 Prompt 工程

---

## 维护说明

### 更新节日日期表

`FESTIVAL_TABLE` 中的农历节日每年需核实对应公历日期。推荐数据来源：

- [nongli114.com](https://www.nongli114.com) — 妈祖诞辰、春节、元宵等农历节日
- [chinesecalendaronline.com](https://www.chinesecalendaronline.com/zh/jieri/chongyang/) — 重阳节（妈祖升天）

当前表覆盖至 **2035 年**，届时需补充后续年份数据。

### 扩展口语词

在 `COLLOQUIAL_OFFSETS` 数组中添加新条目，格式为 `[关键词数组, 天数偏移]`，无需修改解析逻辑。

### 扩展节日

在 `FESTIVAL_TABLE` 中添加新节日名称和对应年份日期数组，`parseFestival` 会自动识别。

### 适配其他领域

替换 `KNOWLEDGE_INDICATORS` 中的词表为目标领域关键词（当前针对非遗/妈祖/汕尾场景）。

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1.0-beta | 2026-02 | 首个可用版本，含五道关卡意图分类、三层日期解析、节日查表、Injectable Clock |

---

## 许可协议

**Copyright © 2026 模多多（Moduoduo）. All Rights Reserved.**

本软件及其全部源代码、文档、算法、数据结构均为模多多（Moduoduo）的专有财产，受中华人民共和国著作权法及国际知识产权法律保护。

**未经版权所有人书面授权，严禁以下行为：**

- 复制、分发、传播本软件的全部或部分内容
- 修改、改编、翻译、演绎本软件
- 将本软件用于任何商业或非商业目的
- 对本软件进行反编译、反汇编或以其他方式还原源代码
- 将本软件整合至任何第三方产品或服务中

**违反上述条款将依法追究法律责任。**

如需获取授权或商业合作，请联系：模多多（Moduoduo）项目团队
# Moduoduo Time Engine (MTE)

**版本**：`v0.1.0-beta-20260221` · **语言**：TypeScript · **依赖**：`chrono-node`（唯一外部依赖）  
**时区**：全局固定深圳时间 `UTC+8`（IANA 键名 `Asia/Shanghai`，深圳/北京/广州同区）

> 为中文 RAG 系统提供时间感知能力的轻量处理层。零 LLM 调用，零额外延迟，中文语义特化。

---

## 是什么

MTE 是一个单文件 TypeScript 模块，解决大模型在时间处理上的三类核心问题：

- **时间幻觉**：模型把"今年"理解成训练截止年份，而不是真实当前年份
- **意图混淆**：分不清用户是在"查历史知识"还是"查实时动态"，导致错误路由
- **日期解析盲区**：中文节日名称、口语模糊词（"前一阵""大前天"）无法被通用库识别

---

## 架构总览

```
用户问题
   │
   ├─► detectTimeIntent()   → 意图分类（knowledge / realtime / mixed）
   │         │
   │         └─► searchQuery（附时间后缀的增强搜索词）
   │
   ├─► injectTimeContext()  → 注入时间上下文到用户消息
   │         │
   │         ├─► timePrompt(clock)   → 写入 System Prompt 时间规则段落
   │         └─► now(clock)          → 替换"今年/本年/今年度"为具体年份
   │
   └─► isWithinWindow()    → 过滤检索结果中超出时间窗口的内容
             │
             └─► parseDate()  → 三层解析 fallback
```

---

## 核心功能

| 函数 | 作用 |
|------|------|
| `now(clock?)` | 唯一时间源，固定深圳时间（UTC+8），返回结构化的日期信息 |
| `timePrompt(clock?)` | 生成注入到 System Prompt 的时间规则段落，约束模型的时间基准 |
| `detectTimeIntent(msg)` | 判断用户问题的时间意图：`knowledge` / `realtime` / `mixed` |
| `parseDate(text, clock?)` | 三层 fallback 解析中文时间表达，返回 `Date` 或 `null` |
| `isWithinWindow(text, days, clock?)` | 判断文本中的日期是否在指定天数窗口内 |
| `noResultSignal(clock?)` | 搜索无结果时生成告知 Prompt，防止模型编造近期动态 |

---

## 快速上手

### 安装依赖

```bash
npm install chrono-node
# 或
pnpm add chrono-node
```

### 基本用法

```typescript
import { now, timePrompt, detectTimeIntent, parseDate, isWithinWindow } from "./moduoduo-time-engine";

// 获取当前时间（深圳时间 UTC+8）
const t = now();
console.log(t.dateStr);      // "2026年2月20日"
console.log(t.year);         // 2026
console.log(t.searchSuffix); // "2026年2月"

// 生成注入 System Prompt 的时间段落
const systemPrompt = `你是一个助手。\n\n${timePrompt()}`;

// 检测用户意图
const intent = detectTimeIntent("妈祖最近有什么活动？");
// → { type: "mixed", freshnessDays: 90, searchQuery: "妈祖最近有什么活动？ 2026年2月" }

const intent2 = detectTimeIntent("皮影戏百年历史介绍");
// → { type: "knowledge", freshnessDays: 180, searchQuery: "皮影戏百年历史介绍" }

// 解析中文日期
const date = parseDate("妈祖诞辰前后");   // → Date 对象（对应当年农历三月廿三）
const date2 = parseDate("大前天");        // → 3天前的 Date 对象

// 鲜度过滤
isWithinWindow("2026年2月的演出", 30);   // → true
isWithinWindow("2020年的演出", 30);      // → false
```

### 在 RAG 管道中使用

```typescript
import { detectTimeIntent, timePrompt, now } from "./moduoduo-time-engine";

async function handleQuery(userMessage: string) {
  // 1. 统一时间基准（同一请求内共享）
  const ref = new Date();
  const clock = () => ref;

  // 2. 检测意图，决定路由
  const intent = detectTimeIntent(userMessage);

  if (intent.type === "knowledge") {
    return await queryKnowledgeBase(userMessage);
  }
  if (intent.type === "realtime") {
    // 使用增强后的搜索词（已附加时间后缀）
    return await webSearch(intent.searchQuery);
  }
  if (intent.type === "mixed") {
    const [kb, web] = await Promise.all([
      queryKnowledgeBase(userMessage),
      webSearch(intent.searchQuery),
    ]);
    return merge(kb, web);
  }
}

// 3. 注入时间上下文到用户消息
function buildUserMessage(question: string): string {
  const ref = new Date();
  const clock = () => ref;
  const { year } = now(clock);

  const normalized = question
    .replace(/今年度/g, `${year}年`)
    .replace(/今年/g, `${year}年`)
    .replace(/本年(?!代|度)/g, `${year}年`);

  return `${timePrompt(clock)}\n\n用户问题：${normalized}`;
}
```

---

## 模块详解

### 1. `now(clock?)` — 唯一时间源

```typescript
export function now(clock?: () => Date): TimeNow
```

返回一个 `TimeNow` 对象，包含当前时间的各维度信息：

| 字段 | 类型 | 示例 | 用途 |
|------|------|------|------|
| `year` | number | `2026` | 替换"今年"代词 |
| `month` | number | `2` | 构建搜索词 |
| `day` | number | `20` | 构建日期字符串 |
| `hour` | number | `14` | 判断时段 |
| `weekday` | string | `"星期五"` | 注入 Prompt |
| `dateStr` | string | `"2026年2月20日"` | 显示用 |
| `isoDate` | string | `"2026-02-20"` | 计算用 |
| `searchSuffix` | string | `"2026年2月"` | 拼接搜索词 |

**关键设计**：使用 `Intl.DateTimeFormat("zh-CN").formatToParts()` 而不是直接 `.format()`，避免 zh-CN locale 把年份格式化为 `"2026年"`（含汉字）导致 `+` 转换时 NaN 的 bug。

---

### 2. `timePrompt(clock?)` — 时间规则段落

```typescript
export function timePrompt(clock?: () => Date): string
```

生成注入到 System Prompt 的时间规则文本，指导模型：

- 以当前日期为基准处理时间词
- 知识库中无当年数据时，明确告知用户而不是用历史数据替代
- 禁止在回答中暴露系统时间元信息

每次请求动态生成，不缓存。

---

### 3. `detectTimeIntent(message)` — 意图检测

```typescript
export function detectTimeIntent(message: string): TimeIntent
```

返回：

```typescript
interface TimeIntent {
  type: "knowledge" | "realtime" | "mixed";
  freshnessDays: number;   // 建议的鲜度窗口（天）
  searchQuery: string;     // 附加时间后缀的增强搜索词
}
```

**判定逻辑**（优先级从高到低）：

| 条件 | 结果 | 示例 |
|------|------|------|
| 含知识覆盖词（"年历史"、"起源"等） | `knowledge` | "皮影戏百年历史" |
| 含独立实时词（"天气"、"新闻"） | `realtime` (1天) | "今天天气怎么样" |
| 含时间词 + 知识领域词 | `mixed` | "妈祖最近有什么活动" |
| 含时间词，无知识领域词 | `realtime` | "最近有什么演出" |
| 无时间词 | `knowledge` | "皮影戏是什么" |

**鲜度天数映射**（多词命中取最大值）：

| 时间词 | 鲜度天数 |
|--------|----------|
| 今天、今日、现在 | 1 天 |
| 昨天、明天 | 2 天 |
| 本周、这周 | 7 天 |
| 本月、这月 | 30 天 |
| 最近、近期 | 90 天 |
| 最新 | 180 天 |

**搜索词时间后缀粒度**（根据鲜度自动调整）：

| 鲜度窗口 | 后缀示例 |
|----------|----------|
| ≤ 3 天 | `"2026年2月20日"` |
| ≤ 14 天 | `"2026年2月"` |
| \> 14 天 | `"2026年2月"` |

#### 判定流程图（五道关卡，顺序过滤）

```
用户消息进来
    │
    ▼
① 空消息 → 直接返回 knowledge（默认值）
    │
    ▼
② 含知识覆盖词？（"百年历史""起源""传说"等）
   → 是 → 强制返回 knowledge（"最近百年历史"不算实时）
    │
    ▼
③ 含独立实时词？（"天气""新闻"）
   → 是 → 直接返回 realtime，鲜度=1天（不需要时间词）
    │
    ▼
④ 含时间词吗？（"最近""本周""今天"等）
   → 否 → 返回 knowledge（没提时间=查知识）
   → 是 → 记录最大鲜度天数，进入第五关
    │
    ▼
⑤ 同时含知识领域词？（"皮影""妈祖""非遗"等）
   → 是 → 返回 mixed（联网 + 知识库都查）
   → 否 → 返回 realtime（纯联网搜索）
```

#### 示例演练

**例 1："妈祖最近有什么活动？"**

| 关卡 | 检测结果 |
|------|---------|
| ② 知识覆盖词 | 无 → 继续 |
| ③ 独立实时词 | 无 → 继续 |
| ④ 时间词 | 命中"最近" → `freshnessDays = 90` |
| ⑤ 知识领域词 | 命中"妈祖" → `type = mixed` |

返回结果：
```typescript
{ type: "mixed", freshnessDays: 90, searchQuery: "妈祖最近有什么活动？ 2026年2月" }
```

**例 2："皮影戏百年历史介绍"**

| 关卡 | 检测结果 |
|------|---------|
| ② 知识覆盖词 | 命中"百年" → **立即返回 knowledge，后续全跳过** |

返回结果：
```typescript
{ type: "knowledge", freshnessDays: 180, searchQuery: "皮影戏百年历史介绍" }
```

> 这就是"知识覆盖"的意义：防止"百年"被误认为时间词而触发联网搜索。

---

### 4. `parseDate(text, clock?)` — 三层日期解析

```typescript
export function parseDate(text: string, clock?: () => Date): Date | null
```

三层 fallback，按优先级顺序执行：

```
第一层：FESTIVAL_TABLE 节日查表
   ↓ 未命中
第二层：chrono-node 简体中文解析
   ↓ 未命中
第三层：COLLOQUIAL_OFFSETS 口语偏移词
   ↓ 未命中
   → 返回 null
```

#### 第一层：节日查表

内置 `FESTIVAL_TABLE`，覆盖 2024–2035 年，共 11 个节日：

| 节日 | 农历日期 | 备注 |
|------|----------|------|
| 春节 | 正月初一 | |
| 元宵节 | 正月十五 | |
| 妈祖诞辰 | 三月廿三 | 日期已逐年核实（nongli114.com） |
| 妈祖升天 | 九月初九 | 与重阳节同日，非笔误 |
| 端午节 | 五月初五 | |
| 中秋节 | 八月十五 | |
| 重阳节 | 九月初九 | 与妈祖升天同日，非笔误 |
| 清明节 | — | 节气，约4月4-5日 |
| 元旦 | — | 固定1月1日 |
| 劳动节 | — | 固定5月1日 |
| 国庆节 | — | 固定10月1日 |

查表逻辑：优先匹配当年 → 退回上年 → 取表中最后一条。年份提取使用 `Intl.DateTimeFormat formatToParts` 确保时区正确。

#### 第二层：chrono-node（简体中文）

使用 `chrono.zh.hans.parseDate()`，覆盖：
- 绝对日期：`"2026年2月12日"`、`"2月12号"`
- 相对表达：`"昨天"`、`"上周三"`、`"3天前"`、`"下个月"`
- 时间点：`"今晚8点"`、`"明天下午"`

#### 第三层：口语模糊词

覆盖 chrono 不支持的中文口语，转换为相对天数偏移：

| 口语词 | 偏移天数 |
|--------|----------|
| 前天 | -2 天 |
| 大前天 | -3 天 |
| 大后天 | +3 天 |
| 前一阵、前阵子、前段时间 | -30 天 |
| 不久前、没多久前 | -7 天 |
| 这几天、这两天 | -3 天 |
| 这阵子、这段时间 | -14 天 |
| 上上周 | -14 天 |
| 上上个月 | -60 天 |

---

### 5. `isWithinWindow(text, maxDays?, clock?)` — 鲜度判断

```typescript
export function isWithinWindow(
  text: string,
  maxDays?: number,        // 默认 180 天
  clock?: () => Date
): boolean
```

判断文本中的日期是否在 `maxDays` 天内。**无法解析时返回 `true`**（宁可放行，不漏掉内容）。

**关键实现细节**：`clock()` 只调用一次，`parseDate` 和 `diffMs` 计算共享同一个 `ref`，消除同一请求内跨秒不一致的可能。

---

### 6. `noResultSignal(clock?)` — 无结果信号

```typescript
export function noResultSignal(clock?: () => Date): string
```

当联网搜索无结果时，注入此文本到 Prompt，告知模型不要编造近期动态。

---

## Injectable Clock 设计

所有函数均接受可选的 `clock: () => Date` 参数：

```typescript
// 生产环境（默认）
now()                      // 使用 new Date()

// 同一请求链路内统一时间源（跨日边界安全）
const ref = new Date();
const clock = () => ref;
now(clock);
timePrompt(clock);
isWithinWindow(text, 30, clock);

// 测试环境（mock 指定时间）
const fixedClock = () => new Date("2026-02-20T12:00:00+08:00");
now(fixedClock);
```

这个设计保证：
- **同一请求内**，`now()`、`timePrompt()`、`isWithinWindow()` 使用同一时间点，不受跨秒/跨日边界影响
- **测试时**，可以 mock 任意时间，不依赖系统时钟

---

## 与 RAG 管道的集成点

```
aliyunBailianService.ts
└── injectTimeContext(question)
    ├── now(clock)         → 获取当前年份，替换"今年"代词
    └── timePrompt(clock)  → 生成时间规则段落，写入用户消息头部
```

> 注意：百炼 App API 会忽略 `system` role，因此时间上下文写在 `user` 消息头部，而非 System Prompt。

---

## 与业界方案的对比分析

> 本节基于对 LangChain、LlamaIndex、学术界 Temporal RAG 论文及主流中文 NLP 库的横向调研。

### 功能模块独特性矩阵

| 本引擎功能 | 业界现成方案 | 独特性评估 |
|-----------|-------------|-----------|
| `timePrompt()` 时间注入 | 工程界公认最佳实践，LangChain / LlamaIndex 均有类似实现 | 通用实践，无显著差异 |
| `isWithinWindow()` 鲜度过滤 | LangChain Retriever 的 `time_filter`、LlamaIndex 的 `TimeWeightedVectorStore` | 思路相同，实现各有侧重 |
| `parseDate()` 日期解析 | 有专门库（chrono-node、dateparser、Natty）比纯手写更全面 | 已通过引入 chrono-node 补齐，加自定义层增强中文口语 |
| `detectTimeIntent()` 意图分类 | **全网找不到现成的中文版等价实现** | **原创护城河，核心差异点** |

### `detectTimeIntent()` — 原创优势

学术界处理 Temporal RAG 的顶级论文（TempRALM、RASTeR、T-GRAG）均存在局限：全部基于英文语料，无中文时间语义词表，无可用开源代码，不做"知识词覆盖实时词"的语义优先级逻辑。

LangChain Query Router 最接近，但：

1. **需要调用一次 LLM 才能分类** — 增加延迟（约 0.5-2s）和费用
2. **没有中文时间语义词表** — 不理解"本周末""最近""当前"的鲜度含义
3. **不做知识覆盖逻辑** — 无法区分"皮影戏最近100年历史"（知识类）vs"皮影戏最近有什么演出"（实时类）

MTE 的核心优势：
```
纯规则 + 词表 → 零 LLM 调用 → 零额外延迟 → 零额外费用
中文语义特化 → 鲜度天数精确映射 → 知识/实时/混合 三分类
```

### `parseDate()` — 三层架构的差异化

| 层级 | 解决的问题 | 纯用 chrono-node 的表现 |
|------|-----------|----------------------|
| 第一层：节日查表 | "妈祖诞辰""春节前后"等节日词 | 无法识别，返回 null |
| 第二层：chrono-node | 标准时间表达 | 正确，已是业界最优解 |
| 第三层：口语偏移词 | "前一阵""大前天""这阵子" | 无法识别，返回 null |

### 当前与顶级方案的差距（诚实评估）

| 差距项 | 对本项目场景的影响 | 优先级建议 |
|--------|-----------------|-----------|
| **节日/农历精度** | 节日查表覆盖 2024-2035，2035年后失效 | 中（2035年到期再补充） |
| **具体星期几** | "下周三的演出安排"类查询解析精度受限 | 低（chrono 已部分覆盖） |
| **日期范围** | "活动持续到X月X日"无法提取结束日期 | 中（可扩展 parseDate） |
| **时间点（时:分）** | "晚上8点开幕的演出"降级为日期精度 | 低（鲜度判断不需要时分精度） |
| **单句多时间段** | "从上周到下周的活动"只识别第一个时间词 | 中（可扩展返回 Date[]） |
| **歧义消解** | "三月活动"在不明年份时依赖当年默认 | 低（clock 注入已缓解） |

---

## 适用场景

- 中文垂直领域 RAG 系统（文旅、非遗、政务、媒体等）
- 需要区分"查知识库"和"联网搜索"的智能路由
- 需要防止大模型时间幻觉的 Prompt 工程

---

## 维护说明

### 更新节日日期表

`FESTIVAL_TABLE` 中的农历节日每年需核实对应公历日期。推荐数据来源：

- [nongli114.com](https://www.nongli114.com) — 妈祖诞辰、春节、元宵等农历节日
- [chinesecalendaronline.com](https://www.chinesecalendaronline.com/zh/jieri/chongyang/) — 重阳节（妈祖升天）

当前表覆盖至 **2035 年**，届时需补充后续年份数据。

### 扩展口语词

在 `COLLOQUIAL_OFFSETS` 数组中添加新条目，格式为 `[关键词数组, 天数偏移]`，无需修改解析逻辑。

### 扩展节日

在 `FESTIVAL_TABLE` 中添加新节日名称和对应年份日期数组，`parseFestival` 会自动识别。

### 适配其他领域

替换 `KNOWLEDGE_INDICATORS` 中的词表为目标领域关键词（当前针对非遗/妈祖/汕尾场景）。

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1.0-beta | 2026-02 | 首个可用版本，含五道关卡意图分类、三层日期解析、节日查表、Injectable Clock |

---

## 许可协议

**Copyright © 2026 模多多（Moduoduo）. All Rights Reserved.**

本软件及其全部源代码、文档、算法、数据结构均为模多多（Moduoduo）的专有财产，受中华人民共和国著作权法及国际知识产权法律保护。

**未经版权所有人书面授权，严禁以下行为：**

- 复制、分发、传播本软件的全部或部分内容
- 修改、改编、翻译、演绎本软件
- 将本软件用于任何商业或非商业目的
- 对本软件进行反编译、反汇编或以其他方式还原源代码
- 将本软件整合至任何第三方产品或服务中

**违反上述条款将依法追究法律责任。**

如需获取授权或商业合作，请联系：模多多（Moduoduo）项目团队