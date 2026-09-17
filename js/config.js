/* =========================================================================
 * config.js —— 骨架参数
 * 这一层是给你（懂考公的人）改的。改数字不需要动任何逻辑代码。
 * ========================================================================= */

window.YT = window.YT || {};

/* 行测模块顺序 + 申论。
 * order 决定基础期的推进顺序，按你给的：
 * 资料 → 言语 → 判推逻辑 → 判推图形 → 判推定义类比 → 政治理论 → 数量 → 常识，申论并行。 */
YT.MODULES = [
  /* weight = 刷题轮转里的权重。资料/言语/判断是提分主力，给高权重；
   * 数量、常识、政治理论靠积累，刷题收益低，权重压低。 */
  { id: 'zlfx', name: '资料分析',      short: '资料',       order: 1, unitMinutes: 2.5, courseUnits: 4, weight: 2.5 },
  { id: 'yy',   name: '言语理解',      short: '言语',       order: 2, unitMinutes: 1.5, courseUnits: 5, weight: 2.5 },
  { id: 'pdlj', name: '判断推理·逻辑', short: '判推逻辑',   order: 3, unitMinutes: 1.5, courseUnits: 4, weight: 2.5 },
  { id: 'pdtx', name: '判断推理·图形', short: '判推图形',   order: 4, unitMinutes: 1.2, courseUnits: 3, weight: 2.5 },
  { id: 'pddl', name: '定义判断·类比', short: '定义类比',   order: 5, unitMinutes: 1.2, courseUnits: 2, weight: 2.5 },
  { id: 'zzll', name: '政治理论',      short: '政治理论',   order: 6, unitMinutes: 1.2, courseUnits: 3, weight: 1.5 },
  { id: 'sl',   name: '数量关系',      short: '数量',       order: 7, unitMinutes: 2.5, courseUnits: 4, weight: 1 },
  { id: 'cs',   name: '常识判断',      short: '常识',       order: 8, unitMinutes: 1.0, courseUnits: 2, weight: 1 },
  { id: 'slw',  name: '申论',          short: '申论',       order: 9, unitMinutes: 40,  courseUnits: 6, weight: 0, essay: true },
];

YT.MODULE_BY_ID = {};
YT.MODULES.forEach(function (m) { YT.MODULE_BY_ID[m.id] = m; });

/* 申论的两个特殊题型的固定时长（分钟） */
YT.ESSAY = {
  smallMinutes: 40,   // 小题 1 道
  bigMinutes: 70,     // 大作文 1 篇
};

YT.CONFIG = {
  /* —— 听课 —— */
  lessonMinutes: 150,     // 每节课的课件时长
  defaultSpeed: 1.5,      // 听课时长 = 课件时长 ÷ 倍速
  minLessonChunk: 25,     // 听课时长不足这个数就不排听课
  maxLessonUnitsPerDay: 3,// 一天最多听几节（全职备考可以到 3 节 = 5 小时）
  maxLessonBlockUnits: 2, // 单条听课任务最多几节，超了就拆成两条

  /* —— 每日时间怎么分 ——
   * course  = 当天时间给听课的比例
   * 剩下的时间按 复盘 = 刷题 × reviewRatio 自动劈成两半 */
  split: {
    base:       { weekday: { course: 0.55 }, weekend: { course: 0.55 } },
    strengthen: { weekday: { course: 0.00 }, weekend: { course: 0.00 } },
    sprint:     { weekday: { course: 0.00 }, weekend: { course: 0.00 } },
  },
  reviewRatio: 0.4,       // 复盘时长 = 刷题时长 × 这个系数
  maxReviewMinutes: 60,   // 复盘再长也没意义，到顶就把时间还给刷题
  maxPracticePerModule: 120, // 同一科一天超过这个时长就拆成"第 1 组 / 第 2 组"，
                             // 不然全职备考会看到"资料分析 150 题"这种吓人的一条
  minPracticeMinutes: 20,  // 剩不到这么久就排不出一组有意义的题，让给消化/复盘

  /* 冲刺期周末的整套卷时长上限 */
  sprintPaperMinutes: 120,
  sprintEssayMinutes: 180,

  /* —— 阶段划分 —— */
  stage: {
    sprintRatio: 0.20,      // 冲刺期占可用学习日的比例
    sprintMin: 14,
    sprintMax: 30,
    baseRatioOfRest: 0.45,  // 基础期占（总天数 − 冲刺期）的比例
  },

  /* —— 申论是独立的一条线 ——
   * 不跟行测抢模块队列，按"本周总时长 × 占比"单独给预算。
   * 预算能滚存：工作日塞不下就攒到周末一起排。 */
  essayShare: { base: 0.35, strengthen: 0.35, sprint: 0 },  // 冲刺期由整套卷逻辑接管
  essayDayCap: 0.5,   // 单日申论最多占当天时间的比例，防止短日被申论吃光

  /* —— 完成率 → 下周怎么办 —— */
  reflow: [
    { min: 0.85, action: 'increase', factor: 1.08, label: '完成度很好，小幅加量' },
    { min: 0.60, action: 'hold',     factor: 1.00, label: '保持总量，把没做完的重新排进下周' },
    { min: 0.40, action: 'reduce',   factor: 0.75, label: '总量降到七成半，重新分配' },
    { min: 0.00, action: 'downgrade',factor: 0.60, label: '先降档，把打卡习惯稳住' },
  ],
  reflowWeekThreshold: 0.5, // 单个模块低于这个完成率，下周减少它的量而不是加倍补
  carryOverCap: 1.2,        // 重排后单日不超过原容量的 120%，超出的直接砍掉

  /* —— 每日感受 → 接下来怎么微调 ——
   * 只看最近 moodWindow 天的感受，取平均分再换算成系数。
   * 太轻松 = +1，刚好 = 0，有点累 = -1，太难了 = -2。 */
  moodWindow: 5,
  moodWeight: 0.08,       // 平均分每 1 分，刷题和复盘的量变动 8%
  moodFactorMin: 0.75,
  moodFactorMax: 1.10,

  /* —— 题量取整 —— */
  amountStep: 5,
  amountMin: 5,
};

/* 感受的分数和显示名 */
YT.MOOD_SCORE = { easy: 1, ok: 0, tired: -1, hard: -2 };
YT.MOOD_LABEL = { easy: '太轻松', ok: '刚好', tired: '有点累', hard: '太难了' };

/* 每日可用时长的预设档位（问卷里用） */
YT.TIME_OPTIONS = [
  { label: '1 小时以内', minutes: 45 },
  { label: '1–2 小时',   minutes: 90 },
  { label: '2–4 小时',   minutes: 180 },
  { label: '4–6 小时',   minutes: 300 },
  { label: '6–8 小时',   minutes: 420 },
  { label: '8 小时以上', minutes: 540 },
];

/* 按每天总时长决定"刷题摊给几个模块"，避免每天只刷一科或摊得太碎 */
YT.practiceSlots = function (totalMinutes, isWeekend) {
  var want = Math.round(totalMinutes / 120);
  var cap = isWeekend ? 4 : 3;
  return Math.max(1, Math.min(cap, want));
};

/* 当前基础 */
YT.BASE_OPTIONS = [
  { id: 'zero',      label: '完全零基础',       desc: '没系统学过，要从头看课' },
  { id: 'watched',   label: '看过一轮课',       desc: '课听过了，题没怎么做' },
  { id: 'practiced', label: '刷过题',           desc: '有一定题量，想系统提分' },
  { id: 'retake',    label: '考过，想补弱项',   desc: '有考试经验，知道短板在哪' },
];

/* 各模块强度，用户可调 */
YT.STRENGTH = {
  strong: { label: '加强',  factor: 1.4 },
  normal: { label: '正常',  factor: 1.0 },
  light:  { label: '减少',  factor: 0.5 },
  skip:   { label: '不学',  factor: 0.0 },
};

/* 初始基础会影响各模块的默认强度与听课需求 */
YT.BASE_PRESET = {
  zero:      { courseFactor: 1.00, baseRatioOfRest: 0.45 },
  watched:   { courseFactor: 0.55, baseRatioOfRest: 0.35 },
  practiced: { courseFactor: 0.30, baseRatioOfRest: 0.25 },
  retake:    { courseFactor: 0.25, baseRatioOfRest: 0.20 },
};

/* 每周休息日的默认值：0=周日 */
YT.DEFAULT_REST_DAYS = [0];

YT.WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
