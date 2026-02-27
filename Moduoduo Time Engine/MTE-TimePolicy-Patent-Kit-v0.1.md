# MTE TimePolicy（专利材料包）v0.1

> 目标：把 MTE 的输出从“散落在 prompt / 字符串”抽象为稳定的、可跨语言复刻的 `TimePolicy` 协议，并提供 20–30 组对照样例，作为专利/交底书的“可验证证据链”。

本文档基于现有实现：
- `moduoduo-time-engine.ts`：`detectTimeIntent()` / `timePrompt()` / `now()` / `parseDate()` / `isWithinWindow()` / `noResultSignal()`
- `MTE Readme.markdown`：意图分类五道关卡、鲜度映射、后缀粒度、Injectable Clock

---

## 1. TimePolicy 是什么（摘要定义）

`TimePolicy` 是一个**与实现语言无关**的结构化 JSON 对象，用来描述：
- **用户问题的时间意图**（knowledge / realtime / mixed）
- **建议的检索路由**（是否查 KB / 是否联网）
- **时间鲜度策略**（freshnessDays、查询后缀粒度）
- **提示词护栏策略**（时间基准、无结果不编造等）
- **可解释性证据**（命中了哪些词表/规则，置信度、原因）

下游（RAG / Agent-Flow / Gateway）只需要消费 `TimePolicy`，不需要知道你是 TS 还是 Rust/Python 实现。

---

## 2. TimePolicy（协议字段定义）

### 2.1 类型与枚举

- `intentType`
  - `"knowledge"`：默认走知识库/静态资料，不强制联网
  - `"realtime"`：偏实时动态，建议联网
  - `"mixed"`：知识 + 实时混合，建议并行 KB + Web

- `suffixGranularity`
  - `"none"`：不加时间后缀
  - `"ymd"`：精确到日（如 `2026年2月20日`）
  - `"ym"`：精确到月（如 `2026年2月`）

- `injectionLocation`（时间护栏注入位置）
  - `"system"`：注入系统消息（若平台支持）
  - `"user_head"`：注入用户消息头部（适配“system role 可能被忽略”的平台）

- `unknownDateBehavior`（解析失败时的窗口策略）
  - `"allow"`：放行（宁可多、不漏）
  - `"downrank"`：不硬过滤，但降低排序分
  - `"block"`：阻断（强过滤，通常不推荐作为默认）

### 2.2 默认值（建议）

这些默认值与当前代码基本一致，便于专利材料与实现对齐：
- `freshnessDaysDefault`: `180`
- `unknownDateBehavior`: `"allow"`
- `timezone`: `"Asia/Shanghai"`
- `injectionLocation`: `"user_head"`（因为你已经明确提到部分平台忽略 `system` role）

---

## 3. TimePolicy JSON Schema（草案）

> 说明：这是“协议草案”，可直接交给代理人/研发同事；代码实现可以先不改，只要能产出同样字段即可。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://moduoduo.example/schemas/timepolicy.schema.json",
  "title": "TimePolicy",
  "type": "object",
  "required": ["version", "refTime", "intent", "routing", "query", "guardrails", "evidence"],
  "properties": {
    "version": {
      "type": "string",
      "description": "协议版本号（不是引擎版本号）。建议从 1.0.0 开始。",
      "default": "1.0.0"
    },
    "engine": {
      "type": "object",
      "description": "可选：引擎实现信息（便于审计/回归）。",
      "properties": {
        "name": { "type": "string", "default": "Moduoduo Time Engine" },
        "impl": { "type": "string", "description": "实现语言/运行时，如 ts-node、rust、python。" },
        "engineVersion": { "type": "string", "description": "引擎版本，如 v0.1.0-beta-20260221。" }
      },
      "additionalProperties": true
    },
    "refTime": {
      "type": "object",
      "description": "参考时间基准（同一请求链路必须一致）。",
      "required": ["timezone", "iso", "dateStr", "weekday", "year", "month", "day"],
      "properties": {
        "timezone": { "type": "string", "default": "Asia/Shanghai" },
        "iso": {
          "type": "string",
          "description": "参考时间 ISO-8601（建议带时区偏移，如 2026-02-20T12:00:00+08:00）。"
        },
        "dateStr": { "type": "string", "description": "如 2026年2月20日" },
        "weekday": { "type": "string", "description": "如 星期五" },
        "year": { "type": "integer" },
        "month": { "type": "integer" },
        "day": { "type": "integer" }
      },
      "additionalProperties": false
    },
    "intent": {
      "type": "object",
      "required": ["intentType", "freshnessDays", "suffixGranularity"],
      "properties": {
        "intentType": { "type": "string", "enum": ["knowledge", "realtime", "mixed"] },
        "freshnessDays": {
          "type": "integer",
          "description": "建议的鲜度窗口（天）。",
          "default": 180,
          "minimum": 0
        },
        "suffixGranularity": { "type": "string", "enum": ["none", "ymd", "ym"], "default": "ym" }
      },
      "additionalProperties": false
    },
    "routing": {
      "type": "object",
      "description": "建议路由（下游可根据策略选择并行/串行）。",
      "required": ["needKB", "needWeb"],
      "properties": {
        "needKB": { "type": "boolean" },
        "needWeb": { "type": "boolean" },
        "mode": {
          "type": "string",
          "enum": ["kb_only", "web_only", "kb_and_web_parallel"],
          "description": "路由模式（可选冗余字段，便于调试）。"
        }
      },
      "additionalProperties": false
    },
    "query": {
      "type": "object",
      "description": "查询增强策略（用于 webSearch 或混合检索）。",
      "required": ["original", "augmented"],
      "properties": {
        "original": { "type": "string" },
        "augmented": { "type": "string", "description": "原始问题 + 时间后缀（若启用）。" },
        "suffix": { "type": "string", "description": "实际追加的时间后缀，可能为空字符串。" }
      },
      "additionalProperties": false
    },
    "guardrails": {
      "type": "object",
      "description": "提示词护栏（用于降低时间幻觉/编造）。",
      "required": ["timePromptEnabled", "noResultSignalEnabled", "injectionLocation"],
      "properties": {
        "timePromptEnabled": { "type": "boolean", "default": true },
        "noResultSignalEnabled": { "type": "boolean", "default": true },
        "injectionLocation": { "type": "string", "enum": ["system", "user_head"], "default": "user_head" },
        "timePromptText": { "type": "string", "description": "可选：生成后的文本，便于调试/落盘。", "default": "" }
      },
      "additionalProperties": false
    },
    "windowing": {
      "type": "object",
      "description": "用于检索结果鲜度控制的建议策略（对应 isWithinWindow 的可扩展形态）。",
      "properties": {
        "maxDays": { "type": "integer", "default": 180 },
        "unknownDateBehavior": { "type": "string", "enum": ["allow", "downrank", "block"], "default": "allow" }
      },
      "additionalProperties": false
    },
    "evidence": {
      "type": "object",
      "description": "可解释性证据：命中哪些规则/词表，为什么判成这个意图。",
      "required": ["confidence", "reasons", "matches"],
      "properties": {
        "confidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.7 },
        "reasons": {
          "type": "array",
          "items": { "type": "string" },
          "description": "人类可读原因列表，建议用于日志/审计/专利举证。"
        },
        "matches": {
          "type": "object",
          "properties": {
            "knowledgeOverrides": { "type": "array", "items": { "type": "string" }, "default": [] },
            "standaloneRealtime": { "type": "array", "items": { "type": "string" }, "default": [] },
            "timeWords": { "type": "array", "items": { "type": "string" }, "default": [] },
            "knowledgeIndicators": { "type": "array", "items": { "type": "string" }, "default": [] }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

---

## 4. 生成规则（与现有实现对齐的“协议化描述”）

> 下面这段用来写专利交底书的“实施例步骤”，尽量不依赖具体编程语言。

- **步骤 S1（参考时间获取）**：获取参考时间 `refTime`，使用固定或可配置时区（默认 `Asia/Shanghai`），同一请求链路内必须保持一致（Injectable Clock）。
- **步骤 S2（知识覆盖词优先）**：若文本命中知识覆盖词（如“百年/起源/由来/古代/年的历史”等），则直接判定 `intentType=knowledge`，并关闭强制联网倾向。
- **步骤 S3（独立实时词优先）**：若文本命中独立实时词（如“天气/新闻”），则直接判定 `intentType=realtime` 且 `freshnessDays=1`，并建议联网。
- **步骤 S4（时间词与鲜度映射）**：若文本命中时间词（如“今天/本周/本月/最近/最新”等），则根据映射表取最大 `freshnessDays`。
- **步骤 S5（领域词决定 mixed）**：若命中时间词且同时命中领域词/知识指标词，则判为 `mixed`，建议 `KB + Web` 并行；否则判为 `realtime`。
- **步骤 S6（查询增强）**：按 `freshnessDays` 决定时间后缀粒度（≤3 天精确到日；≤14 天到月；其余到月），将后缀拼接到 `query.augmented`。
- **步骤 S7（护栏注入）**：生成时间规则段落（timePrompt）与无结果信号（noResultSignal），按平台能力注入到 system 或 user_head。

---

## 5. TimePolicy 示例（3 个）

### 5.1 knowledge（无时间词）

```json
{
  "version": "1.0.0",
  "refTime": {
    "timezone": "Asia/Shanghai",
    "iso": "2026-02-27T10:00:00+08:00",
    "dateStr": "2026年2月27日",
    "weekday": "星期五",
    "year": 2026,
    "month": 2,
    "day": 27
  },
  "intent": { "intentType": "knowledge", "freshnessDays": 180, "suffixGranularity": "none" },
  "routing": { "needKB": true, "needWeb": false, "mode": "kb_only" },
  "query": { "original": "皮影戏是什么", "augmented": "皮影戏是什么", "suffix": "" },
  "guardrails": { "timePromptEnabled": true, "noResultSignalEnabled": true, "injectionLocation": "user_head", "timePromptText": "" },
  "windowing": { "maxDays": 180, "unknownDateBehavior": "allow" },
  "evidence": {
    "confidence": 0.8,
    "reasons": ["未命中时间词，按默认知识类处理"],
    "matches": { "knowledgeOverrides": [], "standaloneRealtime": [], "timeWords": [], "knowledgeIndicators": ["皮影"] }
  }
}
```

### 5.2 realtime（独立实时词）

```json
{
  "version": "1.0.0",
  "refTime": { "timezone": "Asia/Shanghai", "iso": "2026-02-27T10:00:00+08:00", "dateStr": "2026年2月27日", "weekday": "星期五", "year": 2026, "month": 2, "day": 27 },
  "intent": { "intentType": "realtime", "freshnessDays": 1, "suffixGranularity": "ymd" },
  "routing": { "needKB": false, "needWeb": true, "mode": "web_only" },
  "query": { "original": "今天天气怎么样", "augmented": "今天天气怎么样 2026年2月27日", "suffix": "2026年2月27日" },
  "guardrails": { "timePromptEnabled": true, "noResultSignalEnabled": true, "injectionLocation": "user_head", "timePromptText": "" },
  "windowing": { "maxDays": 1, "unknownDateBehavior": "allow" },
  "evidence": {
    "confidence": 0.95,
    "reasons": ["命中独立实时词：天气 → 强制实时"],
    "matches": { "knowledgeOverrides": [], "standaloneRealtime": ["天气"], "timeWords": ["今天"], "knowledgeIndicators": [] }
  }
}
```

### 5.3 mixed（时间词 + 领域词）

```json
{
  "version": "1.0.0",
  "refTime": { "timezone": "Asia/Shanghai", "iso": "2026-02-27T10:00:00+08:00", "dateStr": "2026年2月27日", "weekday": "星期五", "year": 2026, "month": 2, "day": 27 },
  "intent": { "intentType": "mixed", "freshnessDays": 90, "suffixGranularity": "ym" },
  "routing": { "needKB": true, "needWeb": true, "mode": "kb_and_web_parallel" },
  "query": { "original": "妈祖最近有什么活动？", "augmented": "妈祖最近有什么活动？ 2026年2月", "suffix": "2026年2月" },
  "guardrails": { "timePromptEnabled": true, "noResultSignalEnabled": true, "injectionLocation": "user_head", "timePromptText": "" },
  "windowing": { "maxDays": 90, "unknownDateBehavior": "allow" },
  "evidence": {
    "confidence": 0.9,
    "reasons": ["命中时间词：最近 → freshnessDays=90", "同时命中领域词：妈祖 → mixed（KB+Web）"],
    "matches": { "knowledgeOverrides": [], "standaloneRealtime": [], "timeWords": ["最近"], "knowledgeIndicators": ["妈祖"] }
  }
}
```

---

## 6. 对照样例库（24 组，输入→TimePolicy→路由→避免错误）

> 写专利/交底书时，建议把每个样例当成“实施例”，突出：**同样输入，在没有本发明时会出现的错误**，以及本发明如何通过策略输出避免。

为避免篇幅爆炸，这里每个样例只列“关键字段”，其余字段可按 Schema 自动补齐。

### A. “知识覆盖词反转实时”的关键证据（你差异化最强）

#### 示例 A1（核心示例：最近100年历史）
- **输入**：`皮影戏最近100年历史梳理`
- **TimePolicy（关键字段）**：
  - `intent.intentType`: `knowledge`
  - `routing`: `kb_only`
  - `evidence.matches.knowledgeOverrides`: `["百年"]`（或“年历史/年的历史”视具体命中）
- **避免的错误**：把“最近100年”误判为“近期动态”而强制联网，导致答非所问/引用新闻替代学术资料。

#### 示例 A2
- **输入**：`妈祖传说的由来（最近的研究观点也可以）`
- **TimePolicy**：
  - `intentType`: `knowledge`（因“由来/传说”覆盖）
  - `needWeb`: 可选（若你希望“研究观点”触发 mixed，可作为 v0.2 扩展点；当前建议仍 knowledge）
- **避免的错误**：把“最近”当作时间词触发实时搜索，忽略主体是“由来/传说”。

#### 示例 A3
- **输入**：`汕尾非遗近些年发展史`
- **TimePolicy**：
  - `intentType`: `knowledge`（“发展”/“年来/年发展”覆盖）
- **避免的错误**：将“近些年”当成“近期新闻”而偏向搜索，输出碎片化新闻而非发展史脉络。

#### 示例 A4
- **输入**：`皮影戏古代怎么演？`
- **TimePolicy**：
  - `intentType`: `knowledge`（“古代”覆盖）
- **避免的错误**：错误引导到近期活动/演出安排。

### B. 独立实时词（无需时间词也实时）

#### 示例 B1
- **输入**：`汕尾今天的天气`
- **TimePolicy**：`realtime`, `freshnessDays=1`, `suffixGranularity=ymd`, `web_only`
- **避免的错误**：不联网导致输出“常年气候”冒充今天情况。

#### 示例 B2
- **输入**：`妈祖相关新闻`
- **TimePolicy**：`realtime`, `freshnessDays=1`, `web_only`
- **避免的错误**：从知识库抽旧新闻当最新。

#### 示例 B3
- **输入**：`今天有什么新闻？`
- **TimePolicy**：`realtime`, `freshnessDays=1`, `web_only`
- **避免的错误**：模型编造“今天发生了X”。

### C. 时间词 + 领域词 → mixed（KB + Web）

#### 示例 C1
- **输入**：`妈祖最近有什么活动？`
- **TimePolicy**：`mixed`, `freshnessDays=90`, `kb_and_web_parallel`
- **避免的错误**：只查 KB 得到历史活动介绍，无法回答“最近”。

#### 示例 C2
- **输入**：`非遗本月有什么展览？`
- **TimePolicy**：`mixed`, `freshnessDays=30`, `suffix=YYYY年M月`
- **避免的错误**：不带时间后缀检索，召回到多年前的展览页面。

#### 示例 C3
- **输入**：`皮影这周末哪里有演出？`
- **TimePolicy**：`mixed`, `freshnessDays=7`, `suffix=YYYY年M月`（或按你实现可扩到周粒度）
- **避免的错误**：仅基于静态资料回答“皮影很受欢迎”，不提供演出安排。

#### 示例 C4
- **输入**：`汕尾本周有什么节庆？（非遗相关）`
- **TimePolicy**：`mixed`, `freshnessDays=7`
- **避免的错误**：把节庆当百科条目，忽略当周动态。

### D. 时间词但无领域词 → realtime（纯 Web）

#### 示例 D1
- **输入**：`最近有什么演出`
- **TimePolicy**：`realtime`, `freshnessDays=90`, `web_only`, `suffix=YYYY年M月`
- **避免的错误**：走 KB 得到“演出是什么”。

#### 示例 D2
- **输入**：`本月有哪些活动`
- **TimePolicy**：`realtime`, `freshnessDays=30`, `web_only`
- **避免的错误**：泛化回答、没有具体活动。

#### 示例 D3
- **输入**：`最新门票价格`
- **TimePolicy**：`realtime`, `freshnessDays=180`, `web_only`
- **避免的错误**：引用过期价格。

### E. 无时间词 → knowledge（默认）

#### 示例 E1
- **输入**：`妈祖是什么`
- **TimePolicy**：`knowledge`, `kb_only`
- **避免的错误**：强行联网，输出近期新闻当定义。

#### 示例 E2
- **输入**：`介绍一下汕尾陆丰的非遗`
- **TimePolicy**：`knowledge`
- **避免的错误**：把“介绍”当成“近期推荐”。

#### 示例 E3
- **输入**：`皮影戏的起源`
- **TimePolicy**：`knowledge`（命中覆盖词“起源”）
- **避免的错误**：把“起源”误判为“当前起源争议新闻”。

### F. “今年/本年”代词替换（时间幻觉防护的证据）

#### 示例 F1
- **输入**：`今年妈祖诞辰是哪一天？`
- **TimePolicy**：
  - `intentType`: `mixed`（含时间词“今年” + 领域词“妈祖”）
  - `guardrails.timePromptEnabled`: `true`
- **避免的错误**：模型把“今年”当训练截止年份；或把往年日期当今年。

#### 示例 F2
- **输入**：`本年汕尾有哪些大型活动？`
- **TimePolicy**：`realtime` 或 `mixed`（取决于你是否把“汕尾”当领域词；当前实现里“汕尾”在知识指标词中，倾向 mixed）
- **避免的错误**：答成历史活动合集。

### G. “无结果不编造”（专利有益效果证据）

#### 示例 G1
- **输入**：`今天汕尾有什么大型演出？`
- **TimePolicy**：`realtime`, `freshnessDays=1`, `noResultSignalEnabled=true`
- **避免的错误**：无搜索结果时模型编造演出名称/地点/时间。

#### 示例 G2
- **输入**：`最近妈祖相关有什么突发事件？`
- **TimePolicy**：`mixed`, `freshnessDays=90`, `noResultSignalEnabled=true`
- **避免的错误**：编造“突发事件”。

### H. 边界与稳健性（空输入/噪声）

#### 示例 H1
- **输入**：``（空字符串）
- **TimePolicy**：`knowledge`（默认）
- **避免的错误**：不必要联网/错误分类。

#### 示例 H2
- **输入**：`？？？最近`
- **TimePolicy**：`realtime`, `freshnessDays=90`（有时间词但无领域词）
- **避免的错误**：输出“最近发生了很多事”式空泛编造（护栏应仍开启）。

### I. “活动 vs 历史”对照（展示 mixed 与 knowledge 的分界）

#### 示例 I1
- **输入**：`皮影戏最近有什么演出？`
- **TimePolicy**：`mixed`（时间词“最近” + 领域词“皮影”）
- **避免的错误**：只给皮影历史介绍，不给演出信息。

#### 示例 I2
- **输入**：`皮影戏百年历史介绍`
- **TimePolicy**：`knowledge`（命中覆盖词“百年”）
- **避免的错误**：把“百年”误当“最近”并去找“最新演出”。

---

## 7. 建议你在专利交底书里强调的“创新组合点”

- **中文时间意图三分类 + 规则优先级**：知识覆盖词优先于时间词，避免“最近100年历史”误触发实时路由。
- **鲜度映射与查询后缀粒度**：把中文时间词映射到可执行的 freshnessDays，并动态选择“年月日/年月”后缀，提高检索命中并降低过期信息。
- **提示词时间护栏 + 无结果信号**：明确禁止把历史当近期，且无结果时禁止编造，从系统层面降低“时间幻觉”。
- **Injectable Clock 的一致性保障**：同一请求内时间基准一致，避免跨秒/跨日边界导致策略与检索窗口不一致（工程层面的可重复性优势）。

---

## 8. 下一步（如果你要把文档进一步变成“交底书”）

你可以在此文档基础上补充三块，就基本是可交付给代理人的“交底书骨架”了：
- **背景技术**：列出现有框架（如 time-weighted retriever）偏“排序/过滤”，缺“中文意图策略 + 覆盖优先级 + 零 LLM 成本路由”。
- **发明内容**：用步骤 S1~S7 写成“方法权利要求”，再扩成“系统/装置/介质”。
- **实施例与效果对比**：把第 6 节的 24 个例子按“错误→改进”方式写成表格并加 1–2 句解释。

