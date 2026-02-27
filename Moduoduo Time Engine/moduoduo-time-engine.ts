/**
 * Moduoduo Time Engine (MTE) v0.1.0-beta
 * Copyright © 2026 模多多（Moduoduo）. All Rights Reserved.
 * 未经书面授权，禁止任何形式的复制、分发、修改或商业使用。
 *
 * 时间上下文处理层 — 为模多多 RAG 系统提供时间感知能力
 *
 * 单文件、单依赖（chrono-node），固定深圳/中国标准时间（UTC+8）。
 * 所有 agent / 模型调用前 import 此模块即可获得时间感知能力。
 *
 * 导出：
 *   now(clock?)              → 唯一时间源（深圳时间 UTC+8）
 *   timePrompt(clock?)       → 拼到 system prompt 尾部的时间段落
 *   detectTimeIntent(msg)    → { type, freshnessDays, searchQuery }
 *   parseDate(text, clock?)  → Date | null（三层 fallback）
 *   isWithinWindow(text, days, clock?) → boolean
 *   noResultSignal(clock?)   → 搜索无结果时注入的 prompt 文本
 */

import * as chrono from "chrono-node";

// ─── 时区常量 ───────────────────────────────────────────────
// 深圳时间（UTC+8）。注：IANA 标准库中国大陆唯一合法标识符为 Asia/Shanghai，
// 深圳/北京/广州均属同一时区，此处以 Shanghai 为键名，语义为深圳时间。
const TZ = "Asia/Shanghai";

// ─── 1. 唯一时间源 ─────────────────────────────────────────

export interface TimeNow {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: string;
  dateStr: string;       // "2026年2月12日"
  isoDate: string;       // "2026-02-12"
  searchSuffix: string;  // "2026年2月" — 默认追加到搜索词
}

/**
 * 返回当前时间，已固定深圳时间（UTC+8）。
 * 接受可注入的 clock 函数，便于测试时 mock 时间。
 */
export function now(clock: () => Date = () => new Date()): TimeNow {
  const d = clock();

  // formatToParts 返回 [{type:"year",value:"2026"}, {type:"literal",value:"年"}, ...]
  // 只取 value 字段做数字转换，避免 zh-CN locale 把数字格式化为 "2026年" 导致 NaN
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);

  const getPart = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? +p.value : 0;
  };

  const year    = getPart("year");
  const month   = getPart("month");
  const day     = getPart("day");
  const hour    = getPart("hour");
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ, weekday: "short",
  }).format(d).replace("周", "星期");

  return {
    year, month, day, hour, weekday,
    dateStr:      `${year}年${month}月${day}日`,
    isoDate:      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    searchSuffix: `${year}年${month}月`,
  };
}

// ─── 2. System Prompt 时间段落 ─────────────────────────────

export function timePrompt(clock: () => Date = () => new Date()): string {
  const t = now(clock);
  return `【时间基准（强制·内部规则·禁止在回答中提及）】当前：${t.dateStr} ${t.weekday}
· 含时间词（最近/近期/本周/本月/当前/最新/今年/今年度）时，以该日期为基准
· "今年"="${t.year}年"，"本周"=${t.weekday}所在周，"本月"=${t.year}年${t.month}月，"近期"=近30天
· 若知识库中仅有历史年份（非${t.year}年）的数据，须明确告知用户"暂无${t.year}年相关信息"，不得用历史数据替代作答
· 不得将过往年份解释为"最近"或"今年"，不得将历史资料当作当前动态
· 若无近期信息，如实回答"目前未检索到近期相关动态"
· 严禁在回答中出现"根据当前系统时间"、"当前系统时间是"等元信息，直接使用日期即可`;
}

// ─── 3. 时间意图检测 ──────────────────────────────────────

export type TimeIntentType = "knowledge" | "realtime" | "mixed";

export interface TimeIntent {
  type: TimeIntentType;
  freshnessDays: number;   // 鲜度窗口
  searchQuery: string;     // 增强后的搜索词（追加年月/年月日）
}

/** 时间词 → 鲜度天数映射（多词命中取最大窗口） */
const FRESHNESS_MAP: [string, number][] = [
  ["今天", 1], ["今日", 1], ["昨天", 2], ["明天", 2],
  ["本周", 7], ["本周末", 7], ["这周", 7],
  ["本月", 30], ["这月", 30],
  ["刚刚", 3], ["现在", 1], ["当前", 7],
  ["最近", 90], ["近期", 90], ["最新", 180],
];

/** 独立实时词（不依赖搭配） */
const STANDALONE_REALTIME = ["天气", "新闻"];

/** 实时搭配词（需配合时间词才算实时） */
const REALTIME_COLLOCATIONS = [
  "演出", "活动", "安排", "动态", "开业", "开放", "门票", "票价",
  "营业", "开幕", "比赛", "赛事", "展览", "节目",
];

/** 知识修饰词（让「最近」失去实时含义） */
const KNOWLEDGE_OVERRIDES = [
  "年的历史", "年历史", "年发展", "年来", "百年", "千年",
  "起源", "由来", "传说", "古代", "古老",
];

/** 知识领域词 */
const KNOWLEDGE_INDICATORS = [
  "皮影", "非遗", "汕尾", "陆丰", "海丰", "妈祖",
  "传承", "技艺", "什么是", "介绍", "历史", "如何", "怎么", "有哪些",
];

/**
 * 根据鲜度天数动态决定搜索词时间后缀粒度：
 * ≤3天 → 精确到日，≤14天 → 精确到月，其余 → 年月
 */
function buildSuffix(t: TimeNow, freshnessDays: number): string {
  if (freshnessDays <= 3)  return t.dateStr;
  if (freshnessDays <= 14) return `${t.year}年${t.month}月`;
  return t.searchSuffix;
}

export function detectTimeIntent(message: string): TimeIntent {
  const text = message.trim();
  const t = now();

  // 默认：知识类
  const base: TimeIntent = { type: "knowledge", freshnessDays: 180, searchQuery: text };

  if (!text) return base;

  // 知识覆盖：「最近100年历史」→ 知识
  if (KNOWLEDGE_OVERRIDES.some((k) => text.includes(k))) return base;

  // 独立实时词（天气、新闻 → 无需时间词也判定实时）
  if (STANDALONE_REALTIME.some((k) => text.includes(k))) {
    return { type: "realtime", freshnessDays: 1, searchQuery: `${text} ${t.dateStr}` };
  }

  // 检测时间词及其鲜度
  let matchedFreshness = 0;
  let hasTimeWord = false;
  for (const [kw, days] of FRESHNESS_MAP) {
    if (text.includes(kw)) {
      hasTimeWord = true;
      matchedFreshness = Math.max(matchedFreshness, days);
    }
  }

  if (!hasTimeWord) return base;

  // 有时间词：知识领域词 → mixed（联网 + 知识库），否则 → realtime（纯联网）
  const hasKnowledge = KNOWLEDGE_INDICATORS.some((k) => text.includes(k));
  const freshnessDays = matchedFreshness || 90;

  return {
    type: hasKnowledge ? "mixed" : "realtime",
    freshnessDays,
    searchQuery: `${text} ${buildSuffix(t, freshnessDays)}`,
  };
}

// ─── 4. 节日查表（优先于 chrono 解析）─────────────────────

/**
 * 各节日的公历日期，按年列出（2024-2035）。
 * 农历节日换算来源：中国天文年历 / 紫金山天文台。
 * 固定公历节日（元旦/劳动节/国庆）直接列出。
 * 注：妈祖诞辰 = 农历3月23；妈祖升天 = 农历9月9（与重阳节同日）。
 */
const FESTIVAL_TABLE: Record<string, string[]> = {
  "春节":     ["2024-02-10","2025-01-29","2026-02-17","2027-02-06","2028-01-26",
               "2029-02-13","2030-02-03","2031-01-23","2032-02-11","2033-01-31",
               "2034-02-19","2035-02-08"],
  "元宵节":   ["2024-02-24","2025-02-12","2026-03-03","2027-02-20","2028-02-09",
               "2029-02-27","2030-02-17","2031-02-06","2032-02-25","2033-02-14",
               "2034-03-05","2035-02-22"],
  "妈祖诞辰": ["2024-05-01","2025-04-20","2026-05-09","2027-04-29","2028-04-17",
               "2029-05-06","2030-04-25","2031-04-14","2032-05-02","2033-04-22",
               "2034-05-11","2035-04-30"],
  // 妈祖升天日为农历九月初九，与重阳节同日，日期完全相同，非笔误
  "妈祖升天": ["2024-10-11","2025-10-29","2026-10-18","2027-10-08","2028-10-26",
               "2029-10-16","2030-10-05","2031-10-24","2032-10-12","2033-10-31",
               "2034-10-20","2035-10-09"],
  "端午节":   ["2024-06-10","2025-05-31","2026-06-19","2027-06-09","2028-05-28",
               "2029-06-16","2030-06-06","2031-05-26","2032-06-13","2033-06-02",
               "2034-06-21","2035-06-11"],
  "中秋节":   ["2024-09-17","2025-10-06","2026-09-25","2027-09-15","2028-10-03",
               "2029-09-22","2030-10-11","2031-10-01","2032-09-19","2033-10-08",
               "2034-09-27","2035-09-16"],
  // 重阳节为农历九月初九，与妈祖升天日同日，日期完全相同，非笔误
  "重阳节":   ["2024-10-11","2025-10-29","2026-10-18","2027-10-08","2028-10-26",
               "2029-10-16","2030-10-05","2031-10-24","2032-10-12","2033-10-31",
               "2034-10-20","2035-10-09"],
  "清明节":   ["2024-04-04","2025-04-04","2026-04-05","2027-04-05","2028-04-04",
               "2029-04-04","2030-04-05","2031-04-05","2032-04-04","2033-04-05",
               "2034-04-05","2035-04-05"],
  "元旦":     ["2024-01-01","2025-01-01","2026-01-01","2027-01-01","2028-01-01",
               "2029-01-01","2030-01-01","2031-01-01","2032-01-01","2033-01-01",
               "2034-01-01","2035-01-01"],
  "劳动节":   ["2024-05-01","2025-05-01","2026-05-01","2027-05-01","2028-05-01",
               "2029-05-01","2030-05-01","2031-05-01","2032-05-01","2033-05-01",
               "2034-05-01","2035-05-01"],
  "国庆节":   ["2024-10-01","2025-10-01","2026-10-01","2027-10-01","2028-10-01",
               "2029-10-01","2030-10-01","2031-10-01","2032-10-01","2033-10-01",
               "2034-10-01","2035-10-01"],
};

/** 在文本中识别节日名，返回当年（或最近可用年份）的节日日期 */
function parseFestival(text: string, ref: Date): Date | null {
  // 用 Intl 获取深圳时间（UTC+8）的正确年份，避免服务器 UTC 跨年边界偏差
  const year = +new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ,
    year: "numeric",
  }).formatToParts(ref).find((p) => p.type === "year")!.value;
  for (const [name, dates] of Object.entries(FESTIVAL_TABLE)) {
    if (!text.includes(name)) continue;
    // 优先当年，其次上一年，最后取表中最后一条
    const match =
      dates.find((d) => d.startsWith(String(year))) ??
      dates.find((d) => d.startsWith(String(year - 1))) ??
      dates[dates.length - 1];
    if (match) return new Date(match);
  }
  return null;
}

// ─── 5. 口语模糊词解析 ────────────────────────────────────

/**
 * [关键词列表, 天数偏移]
 * 正数 = 未来，负数 = 过去。
 * 覆盖 chrono-node 不识别的中文口语表达。
 */
const COLLOQUIAL_OFFSETS: [string[], number][] = [
  [["前天"],                                       -2],
  [["大前天"],                                     -3],
  [["大后天"],                                      3],
  [["前一阵", "前阵子", "前段时间", "近来", "近些天"], -30],
  [["不久前", "没多久前"],                           -7],
  [["这几天", "这两天", "最近这几天"],               -3],
  [["这阵子", "这段时间"],                          -14],
  [["上上周", "上上个星期"],                        -14],
  [["上上个月"],                                   -60],
];

function parseColloquial(text: string, ref: Date): Date | null {
  for (const [keywords, offsetDays] of COLLOQUIAL_OFFSETS) {
    if (keywords.some((k) => text.includes(k))) {
      const d = new Date(ref);
      d.setDate(d.getDate() + offsetDays);
      return d;
    }
  }
  return null;
}

// ─── 6. 日期解析（三层 fallback） ─────────────────────────

/**
 * 解析文本中的时间表达，返回 Date 或 null。
 * 三层优先级：节日查表 → chrono-node 标准解析 → 口语模糊词兜底。
 * clock 参数保证同一请求链路内使用同一时间基准。
 */
export function parseDate(text: string, clock: () => Date = () => new Date()): Date | null {
  if (!text) return null;
  const ref = clock();

  // 第一层：节日名称优先匹配，避免被 chrono 误解析
  const festival = parseFestival(text, ref);
  if (festival) return festival;

  // 第二层：chrono-node 简体中文标准解析
  // 覆盖：2026年2月12日、昨天/今天/明天、上周三、3天前、今晚8点、日期范围等
  const standard = chrono.zh.hans.parseDate(text, ref);
  if (standard) return standard;

  // 第三层：口语模糊词（前一阵 / 大前天 / 这段时间 等）
  return parseColloquial(text, ref);
}

// ─── 7. 鲜度判断 ──────────────────────────────────────────

/**
 * 判断文本中的日期是否在 maxDays 天窗口内。
 * clock 参数与 parseDate 共享，消除同一请求内的跨秒不一致。
 * 无法解析时返回 true（宁可多不可漏）。
 */
export function isWithinWindow(
  text: string,
  maxDays = 180,
  clock: () => Date = () => new Date(),
): boolean {
  const ref = clock();                        // 只调用一次，消除跨秒不一致
  const parsed = parseDate(text, () => ref);  // 传固定 ref，与下面 diffMs 共享同一时间点
  if (!parsed) return true;
  const diffMs = ref.getTime() - parsed.getTime();
  return diffMs / 86_400_000 <= maxDays;
}

// ─── 8. 无结果信号 ─────────────────────────────────────────

export function noResultSignal(clock: () => Date = () => new Date()): string {
  const t = now(clock);
  return `【联网搜索已执行】截至${t.dateStr}，未检索到符合时间要求的近期信息。请据实回答，不要编造近期动态。`;
}