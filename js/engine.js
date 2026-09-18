/* =========================================================================
 * engine.js —— 计划生成引擎
 * 纯函数，不碰界面、不碰存储、不调用 AI。移植到小程序时这一层原样搬走。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  var C = YT.CONFIG;

  /* 可调参数：用户在设置里改过的值存在 profile.tuning 里，
   * 没改过就用 config.js 里的推荐值。 */
  function T(profile, key) {
    if (profile && profile.tuning && profile.tuning[key] !== undefined
        && profile.tuning[key] !== null && profile.tuning[key] !== '') {
      return Number(profile.tuning[key]);
    }
    return C[key];
  }

  /* 申论占比。冲刺期由整套卷逻辑接管，不再是这个数。 */
  function essayShareFor(profile, stageKey) {
    /* 申论什么时候开始学，用户可配。三档：基础期 / 强化期 / 冲刺期。 */
    var start = (profile && profile.tuning && profile.tuning.essayStartStage) || 'base';
    var order = { base: 0, strengthen: 1, sprint: 2 };
    if ((order[stageKey] || 0) < (order[start] || 0)) return 0;
    /* 冲刺期本来交给整套卷，只有用户明确说"冲刺期才开始学申论"时才走这条线 */
    if (stageKey === 'sprint' && start !== 'sprint') return 0;

    var t = profile && profile.tuning && profile.tuning.essayShare;
    if (t !== undefined && t !== null && t !== '') return Number(t);
    return (C.essayShare && C.essayShare[stageKey]) || 0;
  }

  /* ---------------------------------------------------------------------
   * 日期工具
   * ------------------------------------------------------------------- */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function toKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseKey(k) {
    var p = k.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function addDays(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function dayDiff(aKey, bKey) {
    var a = parseKey(aKey), b = parseKey(bKey);
    return Math.round((b - a) / 86400000);
  }

  /* 本周周一作为周标识 */
  function weekKeyOf(dateKey) {
    var d = parseKey(dateKey);
    var wd = d.getDay();             // 0=周日
    var back = wd === 0 ? 6 : wd - 1; // 回到周一
    return toKey(addDays(d, -back));
  }

  function isRest(date, profile) {
    return (profile.restDays || []).indexOf(date.getDay()) !== -1;
  }

  function isWeekend(date) {
    var wd = date.getDay();
    return wd === 0 || wd === 6;
  }

  /* 统计某区间的学习日（不含休息日） */
  function countStudyDays(fromKey, toKeyExclusive, profile) {
    var n = 0;
    var d = parseKey(fromKey);
    var end = parseKey(toKeyExclusive);
    while (d < end) {
      if (!isRest(d, profile)) n++;
      d = addDays(d, 1);
    }
    return n;
  }

  /* ---------------------------------------------------------------------
   * 第一部分：生成阶段大纲
   * ------------------------------------------------------------------- */

  function buildRoadmap(profile, todayKey) {
    var total = countStudyDays(todayKey, profile.examDate, profile);
    var preset = YT.BASE_PRESET[profile.base] || YT.BASE_PRESET.zero;

    var sprint = Math.round(total * C.stage.sprintRatio);
    sprint = Math.max(C.stage.sprintMin, Math.min(C.stage.sprintMax, sprint));
    if (total - sprint < 10) sprint = Math.max(5, Math.floor(total * 0.25));

    var rest = Math.max(0, total - sprint);
    var base = Math.round(rest * preset.baseRatioOfRest);
    var strengthen = rest - base;

    var stages = [
      { key: 'base',       name: '基础期', studyDays: base,       goal: '把行测各模块和申论过一遍，建立做题手感' },
      { key: 'strengthen', name: '强化期', studyDays: strengthen, goal: '分模块大量刷题，申论开始动笔写' },
      { key: 'sprint',     name: '冲刺期', studyDays: sprint,     goal: '限时套卷和模考，申论成篇，查漏补缺' },
    ];

    /* 把学习日数量落到具体日历日期上 */
    var cursor = parseKey(todayKey);
    var remaining = total;
    stages.forEach(function (st) {
      var used = 0;
      st.startKey = null;
      st.endKey = null;
      while (used < st.studyDays && remaining > 0) {
        if (!isRest(cursor, profile)) {
          if (st.startKey === null) st.startKey = toKey(cursor);
          st.endKey = toKey(cursor);
          used++;
          remaining--;
        }
        if (used < st.studyDays) cursor = addDays(cursor, 1);
      }
      /* 下一个阶段从次日开始，否则两个阶段会共用同一天 */
      cursor = addDays(cursor, 1);
      if (st.startKey === null) { st.startKey = ''; st.endKey = ''; }
    });

    /* 听课容量体检：这些课在基础期内排得下吗 */
    var totalLessonMinutes = 0;
    YT.MODULES.forEach(function (m) {
      /* 申论有自己的预算线，不算进行测的听课体检里 */
      if (m.essay) return;
      totalLessonMinutes += targetUnits(m, profile) * effectiveLesson(profile);
    });
    /* 听课不是只在基础期——没听完的课会一路排到强化期。
     * 所以容量要把强化期也算进来，否则课多的人会被误判成"排不下"。 */
    var baseCap = base * averageCourseMinutes(profile, 'base');
    var strCap = strengthen * averageCourseMinutes(profile, 'strengthen');
    var capacity = baseCap + strCap;
    var capacityPerDay = averageCourseMinutes(profile, 'base');
    var needDays = capacityPerDay > 0 ? Math.ceil(totalLessonMinutes / capacityPerDay) : 999;
    var freeDays = Math.floor(capacity / (capacityPerDay || 1));

    return {
      startKey: todayKey,
      totalStudyDays: total,
      stages: stages,
      lessonCheck: {
        totalMinutes: Math.round(totalLessonMinutes),
        needDays: needDays,
        baseDays: base,
        freeDays: freeDays,
        capacityMinutes: Math.round(capacity),
        /* 容量是按平均值估的，实际排课会把零头也用上，所以给 10% 的余量，
         * 否则"刚好差一点"的情况会一直亮着警告。 */
        fit: totalLessonMinutes <= capacity * 1.15,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /* 按强度折算后，某模块真正要听的课节数 */
  function targetUnits(m, profile) {
    var strength = (profile.strength && profile.strength[m.id]) || 'normal';
    var f = (YT.STRENGTH[strength] || YT.STRENGTH.normal).factor;
    var declared = (profile.courseUnits && profile.courseUnits[m.id]);
    if (declared === undefined || declared === null || declared === '') {
      declared = m.courseUnits;
    }
    return Math.round(Number(declared) * f * 2) / 2;
  }

  function effectiveLesson(profile) {
    var speed = Number(profile.speed) || C.defaultSpeed;
    return (Number(profile.lessonMinutes) || C.lessonMinutes) / speed;
  }

  /* 基础期平均每天能分给听课的分钟数 */
  function averageCourseMinutes(profile, stageKey) {
    var table = C.split[stageKey || 'base'] || C.split.base;
    var wd = profile.weekdayMinutes * table.weekday.course;
    var we = profile.weekendMinutes * table.weekend.course;
    /* 一周里休息掉的天数要扣掉，粗略按 5 个工作日 / 2 个周末日算 */
    var restCount = (profile.restDays || []).filter(function (d) {
      return d === 0 || d === 6;
    }).length;
    var weDays = 2 - restCount;
    var restWork = (profile.restDays || []).filter(function (d) {
      return d !== 0 && d !== 6;
    }).length;
    var wdDays = 5 - restWork;
    var total = wd * wdDays + we * weDays;
    var days = wdDays + weDays;
    return days > 0 ? total / days : 0;
  }

  function stageOf(dateKey, roadmap) {
    if (!roadmap || !roadmap.stages) return 'base';
    for (var i = 0; i < roadmap.stages.length; i++) {
      var st = roadmap.stages[i];
      if (st.startKey && dateKey >= st.startKey && dateKey <= st.endKey) return st.key;
    }
    /* 超出大纲范围：考试日之后就按冲刺期处理 */
    return 'sprint';
  }

  /* 阶段内已经走过多少（0~1） */
  function stageProgress(dateKey, stage, profile) {
    if (!stage.startKey || !stage.endKey) return 0;
    var total = countStudyDays(stage.startKey, stage.endKey, profile) + 1;
    var done = countStudyDays(stage.startKey, dateKey, profile);
    return total > 0 ? Math.min(1, done / total) : 0;
  }

  /* ---------------------------------------------------------------------
   * 第二部分：每日时间预算
   * ------------------------------------------------------------------- */

  function budgetFor(date, profile, stageKey) {
    var weekend = isWeekend(date);
    var total = weekend ? profile.weekendMinutes : profile.weekdayMinutes;
    var table = C.split[stageKey] || C.split.base;
    var courseShare = weekend ? table.weekend.course : table.weekday.course;
    var essayShare = essayShareFor(profile, stageKey);
    return { total: total, courseShare: courseShare, essayShare: essayShare };
  }

  /* ---------------------------------------------------------------------
   * 申论这条线
   * ------------------------------------------------------------------- */

  /* 今天申论可以吃多少分钟。
   * 口径是"本周目标 − 本周已经排掉的"，所以工作日塞不下就自动攒到周末。 */
  function essayAllowance(state, dateKey, profile, share, total) {
    if (!share || share <= 0) return 0;
    var wk = weekKeyOf(dateKey);
    var weekStart = parseKey(wk);

    var weekTotal = 0;
    var weekDays = 0;
    for (var i = 0; i < 7; i++) {
      var d = addDays(weekStart, i);
      if (isRest(d, profile)) continue;
      weekTotal += isWeekend(d) ? profile.weekendMinutes : profile.weekdayMinutes;
      weekDays++;
    }
    var target = Math.round(weekTotal * share);

    var already = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      if (k >= dateKey || weekKeyOf(k) !== wk) return;
      (state.days[k].tasks || []).forEach(function (t) {
        if (t.moduleId === 'slw') already += t.minutes;
      });
    });

    var owed = Math.max(0, target - already);
    var cap = Math.round(total * C.essayDayCap);
    /* 别把一周的申论预算堆在前两天——按本周学习日数均摊。
     * 不然周一一次吃满 50% 的上限，把当天的刷题全挤掉了。 */
    var dailyFair = weekDays > 0 ? Math.ceil(target / weekDays) : total;
    return Math.max(0, Math.min(owed, cap, dailyFair, total));
  }

  /* 本周申论听了几次课、练了几次题 */
  function essayCounters(state, dateKey) {
    var wk = weekKeyOf(dateKey);
    var listens = 0, practices = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      if (k >= dateKey || weekKeyOf(k) !== wk) return;
      (state.days[k].tasks || []).forEach(function (t) {
        if (t.moduleId !== 'slw') return;
        if (t.kind === 'course') listens++; else practices++;
      });
    });
    return { listens: listens, practices: practices };
  }

  /* 今天申论排什么：听课和练题交替，听完一节课就练对应的题。
   * 判断依据是"本周听的次数 vs 练的次数"——谁落后就补谁。 */
  function pickEssayTask(profile, stageKey, dateKey, allow, c, doneUnits, slwTarget, preferCourse) {
    if (allow <= 0) return null;

    var eff = effectiveLesson(profile);
    var remainUnits = Math.max(0, slwTarget - doneUnits);

    /* 课还没听完，而且（本周听课没领先，或者今天要一次排两项）→ 先听课 */
    if (remainUnits > 0 && (preferCourse || c.listens <= c.practices) && allow >= eff * 0.5) {
      /* 先按预算向下取到半节，不能超出当天给申论的那一份 */
      var byBudget = Math.floor((allow / eff) * 2) / 2;
      var take = Math.min(remainUnits, byBudget);
      take = Math.min(take, T(profile, 'maxLessonUnitsPerDay'), C.maxLessonBlockUnits);
      if (take < 0.5) return null;
      return { kind: 'course', units: take, minutes: Math.round(take * eff), from: doneUnits };
    }

    /* 强化期的周末给一篇大作文 */
    if (stageKey === 'strengthen' && isWeekend(parseKey(dateKey))
        && allow >= YT.ESSAY.bigMinutes) {
      return { kind: 'essay', big: true, minutes: YT.ESSAY.bigMinutes };
    }

    if (allow >= YT.ESSAY.smallMinutes) {
      return { kind: 'essay', big: false, minutes: YT.ESSAY.smallMinutes };
    }
    return null;
  }

  function makeEssayTask(dateKey, pick) {
    if (pick.kind === 'course') {
      return {
        id: nextId(dateKey),
        moduleId: 'slw',
        moduleName: '申论',
        kind: 'course',
        title: '申论 · 听课',
        detail: lessonLabel(pick.from || 0, pick.units),
        amounts: pick.units,
        units: pick.units,
        amountText: pick.minutes + ' 分钟',
        minutes: pick.minutes,
        status: 'todo',
        actualMinutes: null,
      };
    }
    return {
      id: nextId(dateKey),
      moduleId: 'slw',
      moduleName: '申论',
      kind: 'essay',
      title: pick.big ? '申论 · 大作文' : '申论 · 小题',
      detail: pick.big ? '完整写一篇，先不限时' : '认真写完 1 道，对照参考答案改',
      amounts: 1,
      amountText: pick.big ? '1 篇' : '1 道',
      minutes: pick.minutes,
      status: 'todo',
      actualMinutes: null,
    };
  }

  /* ---------------------------------------------------------------------
   * 第三部分：听课进度
   * ------------------------------------------------------------------- */

  /* beforeKey 传了就只统计这天之前的进度（生成未来的计划时用） */
  function courseProgress(state, beforeKey) {
    var prog = {};
    YT.MODULES.forEach(function (m) { prog[m.id] = 0; });
    Object.keys(state.days || {}).forEach(function (k) {
      if (beforeKey && k >= beforeKey) return;
      (state.days[k].tasks || []).forEach(function (t) {
        if (t.kind !== 'course') return;
        if (prog[t.moduleId] === undefined) return;
        if (t.status === 'done') prog[t.moduleId] += (t.units || 1);
        else if (t.status === 'half') prog[t.moduleId] += (t.units || 1) / 2;
      });
    });
    /* 上一轮听过的不重来：换考试时把进度带过来，和这一轮听的累加。
     * 单独存一个数，而不是塞一堆"补记"任务进去——
     * 那样会在学习档案里凭空多出一堆记录，还得解释它们是怎么来的。 */
    var inh = state.profile && state.profile.inheritedProgress;
    if (inh) {
      Object.keys(inh).forEach(function (id) {
        if (prog[id] === undefined) return;
        prog[id] += Number(inh[id]) || 0;
      });
    }
    return prog;
  }

  /* 当前该听哪个模块：按 order 找第一个没听完的 */
  function currentCourseModule(profile, progress) {
    var list = YT.MODULES.slice().sort(function (a, b) { return a.order - b.order; });
    for (var i = 0; i < list.length; i++) {
      /* 申论走自己那条线，不排进行测的听课队列 */
      if (list[i].essay) continue;
      var need = targetUnits(list[i], profile);
      if (need <= 0) continue;
      if ((progress[list[i].id] || 0) < need - 0.001) return list[i];
    }
    return null;
  }

  function lessonLabel(fromUnits, takeUnits) {
    var end = fromUnits + takeUnits;
    var out = [];

    var headPartial = (fromUnits % 1) > 0.001;
    var headNo = Math.floor(fromUnits) + 1;

    var midStart = Math.ceil(fromUnits - 0.001);
    var midEnd = Math.floor(end + 0.001);
    var tailPartial = (end % 1) > 0.001;

    if (headPartial) out.push('第 ' + headNo + ' 节（下半）');

    if (midEnd - midStart === 1) {
      out.push('第 ' + (midStart + 1) + ' 节');
    } else if (midEnd - midStart > 1) {
      out.push('第 ' + (midStart + 1) + '–' + midEnd + ' 节');
    }

    if (tailPartial) {
      var tailNo = Math.floor(end) + 1;
      if (!headPartial || tailNo !== headNo) out.push('第 ' + tailNo + ' 节（上半）');
    }

    return out.length ? out.join(' + ') : '第 ' + headNo + ' 节';
  }

  /* ---------------------------------------------------------------------
   * 第四部分：刷题模块轮转
   * ------------------------------------------------------------------- */

  function studyableModules(profile) {
    return YT.MODULES.filter(function (m) {
      if (m.essay) return false;
      var s = (profile.strength && profile.strength[m.id]) || 'normal';
      return s !== 'skip';
    }).sort(function (a, b) { return a.order - b.order; });
  }

  function strengthFactor(profile, id) {
    var s = (profile.strength && profile.strength[id]) || 'normal';
    return (YT.STRENGTH[s] || YT.STRENGTH.normal).factor;
  }

  /* 把当天的刷题分钟数分配给若干模块，返回 [{module, minutes}] */
  function allocatePractice(minutes, count, profile, seed, onlyIds) {
    var all = studyableModules(profile).filter(function (m) {
      return strengthFactor(profile, m.id) > 0;
    });
    var pool = onlyIds && onlyIds.length
      ? all.filter(function (m) { return onlyIds.indexOf(m.id) !== -1; })
      : all;
    if (!pool.length) pool = all;
    if (!pool.length) return [];

    /* 按权重排序后轮转取，seed 保证同一天稳定 */
    var weighted = [];
    pool.forEach(function (m) {
      /* 权重 = 用户设的强度 × 模块本身的性价比。
       * 资料/言语/判断是提分主力，会在轮转里出现得更频繁。 */
      var boost = (profile.practiceBoost && profile.practiceBoost[m.id]) || 1;
      var w = strengthFactor(profile, m.id) * (m.weight === undefined ? 1 : m.weight) * boost;
      if (w <= 0) return;
      var times = Math.max(1, Math.round(w * 2));
      for (var i = 0; i < times; i++) weighted.push(m);
    });

    if (!weighted.length) return [];
    var picked = [];
    for (var i = 0; i < count && weighted.length; i++) {
      var idx = (seed + i * 3) % weighted.length;
      var m = weighted[idx];
      var guard = 0;
      while (picked.indexOf(m) !== -1 && guard < weighted.length) {
        idx = (idx + 1) % weighted.length;
        m = weighted[idx];
        guard++;
      }
      if (picked.indexOf(m) === -1) picked.push(m);
    }
    if (!picked.length) picked.push(weighted[0]);

    var each = Math.floor(minutes / picked.length);
    return picked.map(function (m, i) {
      var mins = i === picked.length - 1 ? minutes - each * (picked.length - 1) : each;
      return { module: m, minutes: mins };
    });
  }

  function roundAmount(n) {
    var v = Math.round(n / C.amountStep) * C.amountStep;
    return Math.max(C.amountMin, v);
  }

  /* 按"组"安排刷题。一组 = 真题套卷里这个模块的题量。
   * 时间不够一整组就排半组——真实备考不会有人做"17 道资料分析"这种数。
   * 返回 null 表示时间不够半组，这个模块今天不排。 */
  function planSets(minutes, module, stage, profile) {
    var setSize = YT.moduleParam(module, profile, 'setSize');
    var examMinutes = YT.moduleParam(module, profile, 'examMinutes');
    if (!setSize || !examMinutes) return null;
    var perQ = YT.unitMinutesFor(module, stage, profile);
    if (!perQ || perQ <= 0) return null;
    var setMinutes = setSize * perQ;
    var sets = minutes / setMinutes;
    /* 只排整组，不排半组——真实备考是按组做的。
     * 装不下一整组就留白，不硬凑。
     * 不设组数上限：高强度刷专题的人一天可能刷十几组、几百道题，
     * 那是正常的，不该被系统卡住。 */
    /* 允许半组：一组 50 分钟太粗，"太难了"要减 35 分钟的话
     * 不砍半组就无处可落。10 道题在真实刷题里也很常见。 */
    sets = Math.floor(sets * 2) / 2;
    if (sets < 0.5) return null;
    var qty = Math.max(1, Math.round(setSize * sets));
    return {
      sets: sets,
      qty: qty,
      perQ: perQ,
      minutes: Math.round(qty * perQ),
      setSize: setSize,
    };
  }

  function setLabel(plan) {
    if (plan.sets === 1) return plan.qty + ' 题';
    if (plan.sets === 0.5) return '半组 · ' + plan.qty + ' 题';
    /* 组数少的时候带上组数（"3 组 · 30 题"有信息量）；
     * 组数一大，"11 组"这种说法反而没人这么讲，直接说题数。 */
    if (plan.sets <= 4) return plan.sets + ' 组 · ' + plan.qty + ' 题';
    return plan.qty + ' 题';
  }

  /* ---------------------------------------------------------------------
   * 第五部分：生成某一天
   * ------------------------------------------------------------------- */

  var uid = 0;
  function nextId(dateKey) {
    uid++;
    return dateKey + '#' + uid;
  }

  /* 感受调整算两遍：一遍不调、一遍按系数调，然后逐类合并。
   * 合并规则是单调的——减量的日子任何一类任务都不能变多，
   * 加量的日子任何一类都不能变少。这样才不会出现
   * "选了太难了刷题反而变多"那种反向信号。 */
  function buildTasks(date, dateKey, state, roadmap, opts) {
    var moodF = (opts && opts.moodFactor) || 1;
    var shared = { progress: opts && opts.progress, factor: opts && opts.factor };
    if (moodF === 1) {
      return buildTasksInner(date, dateKey, state, roadmap,
        { progress: shared.progress, factor: shared.factor, moodF: 1 });
    }
    var base = buildTasksInner(date, dateKey, state, roadmap,
      { progress: shared.progress, factor: shared.factor, moodF: 1 });
    var adj = buildTasksInner(date, dateKey, state, roadmap,
      { progress: shared.progress, factor: shared.factor, moodF: moodF });
    return mergeMonotone(base, adj, moodF > 1);
  }

  function taskKey(t) { return t.moduleId + '|' + t.kind; }

  function sumBy(list) {
    var m = {};
    list.forEach(function (t) { m[taskKey(t)] = (m[taskKey(t)] || 0) + t.minutes; });
    return m;
  }

  function mergeMonotone(base, adj, up) {
    var baseBy = sumBy(base), adjBy = sumBy(adj);
    var keys = [];
    base.concat(adj).forEach(function (t) {
      var k = taskKey(t);
      if (keys.indexOf(k) === -1) keys.push(k);
    });
    var out = [];
    keys.forEach(function (k) {
      var b = baseBy[k] || 0, a = adjBy[k] || 0;
      /* 减量时还要保证"不让某一类任务整个消失"——
       * 20% 的削减如果刚好把一组题挤掉，就会变成"太难了今天一道题都不做"，
       * 那是过度反应。这一类宁可保持原样。 */
      var useAdj = up ? (a >= b) : (a <= b && !(a === 0 && b > 0));
      (useAdj ? adj : base).forEach(function (t) {
        if (taskKey(t) === k) out.push(t);
      });
    });
    return out;
  }

  function buildTasksInner(date, dateKey, state, roadmap, opts) {
    var profile = state.profile;
    var stageKey = stageOf(dateKey, roadmap);
    var budget = budgetFor(date, profile, stageKey);
    var factor = (opts && opts.factor) || 1;
    var moodF = (opts && opts.moodF) || 1;
    /* 感受作用在当天总预算上——听课占了大头，只调刷题复盘的话
     * 用户根本感觉不到。变多/变少由外面的 mergeMonotone 保证。 */
    var total = Math.max(0, Math.round(budget.total * factor * moodF));
    /* 不带感受的版本。套卷要按考试时限排，不能因为"太轻松"就加时间——
     * 行测就是 120 分钟，而且这块只会越做越快。 */
    var baseTotal = Math.max(0, Math.round(budget.total * factor));
    var tasks = [];
    var dayIndex = dayDiff(roadmap.startKey || dateKey, dateKey);
    var progress = opts && opts.progress ? opts.progress : courseProgress(state);
    var spent = 0;
    var weekend = isWeekend(date);

    /* ---- 申论：独立的一条线，先占位 ----
     * 放在最前面，是为了保证它不会被行测挤掉。申论和行测是两种能力，
     * 不能因为行测模块多就一直往后拖。 */
    var slwStrength = (profile.strength && profile.strength.slw) || 'normal';
    if (slwStrength !== 'skip' && budget.essayShare > 0) {
      var allow = essayAllowance(state, dateKey, profile, budget.essayShare, total);
      var ec = essayCounters(state, dateKey);
      var doneUnits = (progress && progress.slw) || 0;
      var slwTarget = targetUnits(YT.MODULE_BY_ID.slw, profile);
      var guardE = 0;
      /* 预算够就一天排两个：先听课，再练对应的题 */
      while (allow > 0 && guardE < 2) {
        guardE++;
        /* 同一天要排两个时，第一个必须是课——听完对应的课马上练对应的题 */
        var canPair = guardE === 1 && (slwTarget - doneUnits) > 0
          && allow >= effectiveLesson(profile) * 0.5 + YT.ESSAY.smallMinutes;
        var pick = pickEssayTask(profile, stageKey, dateKey, allow, ec, doneUnits, slwTarget, canPair);
        if (!pick || spent + pick.minutes > total) break;
        /* 第二个任务只允许是练题，不能再塞一节课 */
        if (guardE === 2 && pick.kind === 'course') break;
        tasks.push(makeEssayTask(dateKey, pick));
        spent += pick.minutes;
        allow -= pick.minutes;
        if (pick.kind === 'course') { doneUnits += pick.units; ec.listens++; }
        else { ec.practices++; }
      }
      /* 同一天排了两道小题就合成一条，别显示成两条一模一样的 */
      var slwTasks = tasks.filter(function (t) {
        return t.moduleId === 'slw' && t.kind === 'essay';
      });
      if (slwTasks.length === 2 && slwTasks[0].title === slwTasks[1].title) {
        var ea = slwTasks[0], eb = slwTasks[1];
        ea.amounts = 2;
        ea.amountText = '2 道';
        ea.detail = '认真写完 2 道，对照参考答案改';
        ea.minutes += eb.minutes;
        tasks.splice(tasks.indexOf(eb), 1);
      }
    }

    /* ---- 行测听课 ---- */
    if (budget.courseShare > 0 && total - spent > 0) {
      var eff = effectiveLesson(profile);
      var want = (total - spent) * budget.courseShare;
      var units = Math.round((want / eff) * 2) / 2;   // 以半节为粒度，标签才读得懂
      units = Math.min(units, T(profile, 'maxLessonUnitsPerDay'));
      if (units * eff >= C.minLessonChunk) {
        var m = currentCourseModule(profile, progress);
        if (m) {
          var need = targetUnits(m, profile) - (progress[m.id] || 0);
          var take = Math.round(Math.min(units, need) * 2) / 2;
          if (take > 0) {
            /* 一天要听 3 节的话拆成 2+1，一条"连听 5 小时"没人看得下去 */
            var from = progress[m.id] || 0;
            var left = take;
            while (left > 0.001) {
              var chunk = Math.min(C.maxLessonBlockUnits, left);
              var listenMin = Math.round(chunk * eff);
              tasks.push({
                id: nextId(dateKey),
                moduleId: m.id,
                moduleName: m.name,
                kind: 'course',
                title: m.short + ' · 听课',
                detail: lessonLabel(from, chunk),
                amounts: chunk,
                units: chunk,
                amountText: listenMin + ' 分钟',
                minutes: listenMin,
                status: 'todo',
                actualMinutes: null,
              });
              spent += listenMin;
              from += chunk;
              left -= chunk;
            }
          }
        }
      }
    }

    /* ---- 剩下的时间：刷题 与 复盘 ---- */
    var remaining = Math.max(0, total - spent);

    /* 冲刺期：周末按模考日排，工作日按模块专练排 */
    if (stageKey === 'sprint') {
      if (weekend) {
        /* 套卷用 baseTotal（不带感受），复盘用 total（带感受） */
        var pool = Math.max(0, baseTotal);
        var paper = Math.min(C.sprintPaperMinutes, Math.round(pool * 0.42));
        var essayLeft = pool - paper;

        if (paper >= 30) {
          tasks.push(makePaper(dateKey, '行测整套限时', '按考试时间做完，中途不停表', paper));
        }
        if (essayLeft >= 150) {
          /* 用户把申论线设在冲刺期时，上面已经排过申论了，这里不再叠一套 */
          if (!(profile.tuning && profile.tuning.essayStartStage === 'sprint')) {
            tasks.push(makePaper(dateKey, '申论整套', '完整写一套，对照答案自己批一遍',
                                 Math.min(C.sprintEssayMinutes, essayLeft), 'slw', '申论'));
          }
        } else if (essayLeft >= 70) {
          if (!(profile.tuning && profile.tuning.essayStartStage === 'sprint')) {
            tasks.push(makePaper(dateKey, '申论 · 大作文', '完整写一篇，写完自己对答案改', 70, 'slw', '申论'));
          }
        } else if (paper >= 30) {
          var lastPaper = tasks[tasks.length - 1];
          lastPaper.minutes += essayLeft;
          lastPaper.amountText = lastPaper.minutes + ' 分钟';
        }
        var rv = Math.min(T(profile, 'maxReviewMinutes'), Math.max(20, Math.round(total * 0.15)));
        if (rv >= 10) tasks.push(makeReview(dateKey, rv, true));
        return tasks;
      }

      var rr = errorRateFor(state) * T(profile, 'reviewRatio');
      var rvW = Math.min(T(profile, 'maxReviewMinutes'),
                         Math.max(15, Math.round(remaining * rr / (1 + rr))));
      var pmW = remaining - rvW;
      if (pmW >= 20) tasks.push(makePaper(dateKey, '行测模块专练', '挑两个最弱的模块集中刷', pmW));
      if (rvW >= 10) tasks.push(makeReview(dateKey, rvW, true));
      return tasks;
    }

    var reviewRatio = errorRateFor(state) * T(profile, 'reviewRatio');
    var reviewMinutes = Math.min(T(profile, 'maxReviewMinutes'),
                                 Math.round(remaining * reviewRatio / (1 + reviewRatio)));
    var practiceMinutes = remaining - reviewMinutes;

    if (practiceMinutes >= 15) {
      var learned = [];
      Object.keys(progress).forEach(function (id) {
        var mod = YT.MODULE_BY_ID[id];
        if (!mod || mod.essay) return;
        if ((progress[id] || 0) > 0) learned.push(id);
      });
      var curM = currentCourseModule(profile, progress);
      if (curM && learned.indexOf(curM.id) === -1) learned.push(curM.id);

      /* 每个模块至少要分到 20 分钟，否则不硬拆 */
      var wantSlots = YT.practiceSlots(total, weekend);
      var slots = Math.max(1, Math.min(wantSlots, Math.floor(practiceMinutes / 20)));
      var alloc = allocatePractice(practiceMinutes, slots, profile, dayIndex * 7 + date.getDate(),
                                   stageKey === 'base' ? learned : null);
      var practiceTasks = [];
      alloc.forEach(function (a) {
        var plan = planSets(a.minutes, a.module, stageKey, profile);
        if (!plan) return;
        /* 一条任务别长得离谱，按整组切成几条。
         * 注意这是"单条任务的长度"，不是一天的总量上限——
         * 想高强度刷题就多切几条，总量不受影响。 */
        var setMinutes = plan.setSize * plan.perQ;
        var maxSetsPerTask = Math.max(1, Math.floor(T(profile, 'maxPracticePerModule') / setMinutes));
        var totalChunks = Math.ceil(plan.sets / maxSetsPerTask);
        var left = plan.sets;
        var gi = 0;
        while (left > 0) {
          gi++;
          var thisSets = Math.min(maxSetsPerTask, left);
          var thisQty = thisSets * plan.setSize;
          left -= thisSets;
          var sub = { sets: thisSets, qty: thisQty, perQ: plan.perQ, setSize: plan.setSize };
          practiceTasks.push({
            id: nextId(dateKey),
            moduleId: a.module.id,
            moduleName: a.module.name,
            kind: 'practice',
            title: a.module.short + ' · 刷题' + (totalChunks > 1 ? '（' + gi + '/' + totalChunks + '）' : ''),
            detail: setLabel(sub),
            amount: thisQty,
            sets: thisSets,
            amountText: setLabel(sub),
            minutes: Math.round(thisQty * plan.perQ),
            status: 'todo',
            actualMinutes: null,
          });
        }
      });
      if (practiceTasks.length) {
        tasks = tasks.concat(practiceTasks);
      }
      /* 剩下装不下一整组的时间不硬凑。
       * 这是"基础任务"，本来就该留白给用户自己安排；以前会把零头塞给
       * "课程消化"，结果每天排得满满当当，用户自己加什么都成了超载。 */
    }

    /* ---- 复盘 ---- */
    if (reviewMinutes >= 12 && tasks.length) {
      var hasPractice = tasks.some(function (t) {
        return t.kind === 'practice' || t.kind === 'paperset';
      });
      tasks.push(makeReview(dateKey, reviewMinutes, hasPractice));
    }

    return tasks;
  }

  function makeReview(dateKey, minutes, hasPractice) {
    return {
      id: nextId(dateKey),
      moduleId: 'review',
      moduleName: '复盘',
      kind: 'review',
      title: hasPractice ? '错题复盘' : '课程消化',
      detail: hasPractice ? '把今天做错的题重做一遍，记下错因'
                          : '把今天听的内容过一遍，记下没懂的地方',
      amountText: minutes + ' 分钟',
      minutes: minutes,
      status: 'todo',
      actualMinutes: null,
    };
  }

  function makePaper(dateKey, title, detail, minutes, moduleId, moduleName) {
    return {
      id: nextId(dateKey),
      moduleId: moduleId || 'mix',
      moduleName: moduleName || '行测',
      kind: 'paperset',
      title: title,
      detail: detail,
      amounts: 1,
      amountText: minutes + ' 分钟',
      minutes: minutes,
      status: 'todo',
      actualMinutes: null,
    };
  }

  function restDayRecord(k, roadmap) {
    return {
      date: k, isRest: true, stage: stageOf(k, roadmap),
      tasks: [], mood: null, generatedAt: new Date().toISOString(),
    };
  }

  /* 保证从今天起至少有 ahead 个学习日已排好。
   * 关键：一边生成一边把"已经排进去的听课量"累加起来，
   * 这样第 2 天不会又从头排第 1 节。 */
  function ensureAhead(state, todayKey, ahead) {
    var profile = state.profile;
    var roadmap = state.roadmap;
    if (!roadmap) return state;
    roadmap.startKey = roadmap.startKey || todayKey;

    var projected = courseProgress(state, todayKey);
    var mf = moodFactor(state, todayKey);
    var ri = restartInfo(state, todayKey);
    var d = parseKey(todayKey);
    var made = 0;
    var guard = 0;

    while (made < ahead && guard < 400) {
      guard++;
      var k = toKey(d);
      if (profile.examDate && k > profile.examDate) break;

      if (isRest(d, profile)) {
        if (!state.days[k]) state.days[k] = restDayRecord(k, roadmap);
      } else {
        var day = state.days[k];
        if (!day) {
          var rf = reflowForDate(state, k, todayKey);
          /* 断更回来的第一天，只按重启系数排。
           * 再叠一层"上周完成率低"的话，0.6 × 0.6 = 0.36，
           * 等于回来第一天就给三成任务——那不叫接上，那叫劝退。 */
          var dayFactor = (ri.active && k === todayKey) ? ri.factor : rf.factor;
          day = {
            date: k, isRest: false, stage: stageOf(k, roadmap),
            tasks: buildTasks(d, k, state, roadmap, {
              progress: projected,
              factor: dayFactor,
              moodFactor: mf.factor,
            }),
            mood: null, generatedAt: new Date().toISOString(),
          };
          state.days[k] = day;
        }
        /* 已有的天也要计入，否则后面的排课会跟它对不上 */
        (day.tasks || []).forEach(function (t) {
          if (t.kind === 'course' && t.units) {
            projected[t.moduleId] = (projected[t.moduleId] || 0) + t.units;
          }
        });
        made++;
      }
      d = addDays(d, 1);
    }
    return state;
  }

  /* ---------------------------------------------------------------------
   * 第六部分：每周复盘与重排
   * ------------------------------------------------------------------- */

  function dayStats(day) {
    var planned = 0, done = 0;              // 系统排的基础任务
    var extraPlanned = 0, extraDone = 0;    // 用户自己加的任务
    var byModule = {}, extraByModule = {};
    (day.tasks || []).forEach(function (t) {
      var cr = t.status === 'done' ? 1 : t.status === 'half' ? 0.5 : 0;
      var bag = t.userAdded ? extraByModule : byModule;
      if (t.userAdded) { extraPlanned += t.minutes; extraDone += t.minutes * cr; }
      else { planned += t.minutes; done += t.minutes * cr; }

      var g = t.moduleId;
      if (!bag[g]) bag[g] = { planned: 0, done: 0, name: t.moduleName };
      bag[g].planned += t.minutes;
      bag[g].done += t.minutes * cr;
    });
    return {
      planned: planned, done: done,
      /* 完成率只用系统排的任务算。用户自己加的量不计入——
       * 那个数字是用来判断"系统排的量合不合适"的，
       * 混进用户自己加的部分会掩盖真实的信号。 */
      rate: planned > 0 ? done / planned : 0,
      extraPlanned: extraPlanned, extraDone: extraDone,
      totalPlanned: planned + extraPlanned,
      totalDone: done + extraDone,
      byModule: byModule,
      extraByModule: extraByModule,
    };
  }

  function weekStats(state, weekKey) {
    var totals = { planned: 0, done: 0, byModule: {}, days: 0 };
    Object.keys(state.days).sort().forEach(function (k) {
      if (weekKeyOf(k) !== weekKey) return;
      var day = state.days[k];
      if (day.isRest) return;
      var s = dayStats(day);
      if (s.planned === 0) return;
      totals.days++;
      totals.planned += s.planned;
      totals.done += s.done;
      Object.keys(s.byModule).forEach(function (mid) {
        if (!totals.byModule[mid]) totals.byModule[mid] = { planned: 0, done: 0, name: s.byModule[mid].name };
        totals.byModule[mid].planned += s.byModule[mid].planned;
        totals.byModule[mid].done += s.byModule[mid].done;
      });
    });
    totals.rate = totals.planned > 0 ? totals.done / totals.planned : 0;
    return totals;
  }

  function reflowRule(rate) {
    for (var i = 0; i < C.reflow.length; i++) {
      if (rate >= C.reflow[i].min) return C.reflow[i];
    }
    return C.reflow[C.reflow.length - 1];
  }

  /* 根据上一周的表现，给未来若干学习日一个量调整系数 */
  function computeReflow(state, weekKey) {
    var ws = weekStats(state, weekKey);
    if (!ws.planned) return { rule: null, factor: 1, ws: ws, moduleAdjust: {} };
    var rule = reflowRule(ws.rate);

    var moduleAdjust = {};
    Object.keys(ws.byModule).forEach(function (mid) {
      var m = ws.byModule[mid];
      var r = m.planned > 0 ? m.done / m.planned : 1;
      if (r < C.reflowWeekThreshold) moduleAdjust[mid] = 'reduce';
      else if (r > 0.9) moduleAdjust[mid] = 'ok';
    });

    return { rule: rule, factor: rule ? rule.factor : 1, ws: ws, moduleAdjust: moduleAdjust };
  }

  /* ---------------------------------------------------------------------
   * 断更与重启（C1b）
   *
   * 停 2 天内：正常继续。
   * 停 3–7 天：回来第一天按 80% 排。
   * 停 8 天以上：按 60% 排，并且不补落下的内容，直接按剩下的时间重排。
   *
   * 原则是"先接上，再补"。停了十天的人打开看到"待完成 87 项"就直接卸载了。
   * ------------------------------------------------------------------- */

  /* 今天之前最后一个"真正动过"的日子（打过卡、哪怕只打了半个） */
  function lastActiveKey(state, beforeKey) {
    var keys = Object.keys(state.days || {}).sort();
    for (var i = keys.length - 1; i >= 0; i--) {
      var k = keys[i];
      if (k >= beforeKey) continue;
      var day = state.days[k];
      if (!day || day.isRest) continue;
      var touched = (day.tasks || []).some(function (t) { return t.status !== 'todo'; });
      if (touched) return k;
    }
    return null;
  }

  /* 中间漏掉的"学习日"有多少个——休息日不算。
   * 用户的话：周日休息的人，不该因为跨了个周日就被算成断更。
   * 比如周五学完，周一周二没学周三回来：日历上隔了 5 天，
   * 但中间只有 3 个该学习的日子，按 3 算。 */
  function missedStudyDays(profile, fromKey, toKey2) {
    if (!fromKey || !toKey2) return 0;
    var d = addDays(parseKey(fromKey), 1);
    var end = parseKey(toKey2);
    var n = 0, guard = 0;
    while (d < end && guard < 400) {
      guard++;
      if (!isRest(d, profile)) n++;
      d = addDays(d, 1);
    }
    return n;
  }

  /* 今天算不算"断了之后回来的第一天" */
  function restartInfo(state, todayKey) {
    var today = state.days[todayKey];
    if (today && !today.isRest) {
      var busy = today.mood || (today.tasks || []).some(function (t) {
        return t.status !== 'todo';
      });
      if (busy) return { active: false, gap: 0, missed: 0, factor: 1, level: 'none', lastKey: null };
    }
    var last = lastActiveKey(state, todayKey);
    if (!last) return { active: false, gap: null, missed: null, factor: 1, level: 'none', lastKey: null };
    var gap = dayDiff(last, todayKey);                                          // 日历天，用来显示"上次学习是几天前"
    var missed = missedStudyDays(state.profile, last, todayKey);                // 学习日，用来判断断没断
    if (missed <= 2) {
      return { active: false, gap: gap, missed: missed, factor: 1, level: 'none', lastKey: last };
    }
    return {
      active: true,
      gap: gap,
      missed: missed,
      lastKey: last,
      factor: missed >= 8 ? 0.6 : 0.8,
      level: missed >= 8 ? 'long' : 'short',
    };
  }

  /* 一天"还没动过"的定义：没有任何状态变化、没选感受、也没自己加过东西。
   * 自己加过的任务必须保住——那是用户亲手写的，不能替他清掉。 */
  function untouched(day) {
    if (!day || day.isRest) return false;
    if (day.mood) return false;
    return !(day.tasks || []).some(function (t) {
      return t.status !== 'todo' || t.userAdded;
    });
  }

  /* 断更之后回来：清掉断更期间"排了但一下都没碰"的日子，
   * 再把今天重排一遍（按重启系数）。
   * 不清的话，那些天会全部算成"没完成"，用户一打开就是一屁股债。 */
  function applyRestart(state, todayKey) {
    var info = restartInfo(state, todayKey);
    if (!info.active) return null;

    var cleared = 0;
    Object.keys(state.days).forEach(function (k) {
      if (k >= todayKey || k <= info.lastKey) return;
      var day = state.days[k];
      if (!day || day.isRest || day.mood) return;
      /* 打过卡的、动过的不碰 */
      if ((day.tasks || []).some(function (t) { return t.status !== 'todo'; })) return;
      if (!(day.tasks || []).length) return;
      /* 自己加的任务是他亲手写的，留着；只清系统排的那部分 */
      day.tasks = day.tasks.filter(function (t) { return t.userAdded; });
      day.cleared = true;   // 留个痕，方便调试时看出这天是被清过的
      cleared++;
    });

    /* 今天如果还是原封不动的旧计划，删掉重排，让它带上重启系数 */
    if (untouched(state.days[todayKey])) delete state.days[todayKey];

    info.clearedDays = cleared;
    return info;
  }

  /* 每日感受换算成的量调整系数。
   * 只看最近若干天，避免某一天心情不好就把整个计划带偏。 */
  /* 错误率。用户录过成绩就用他的真实数据，没录过按 30% 估。
   * 用最近三次的平均，避免某一次考砸把复盘时间撑得很大。 */
  function errorRateFor(state) {
    var scores = state.scores || [];
    if (!scores.length) return C.defaultErrorRate;
    var recent = scores.slice(-3);
    var sum = 0, n = 0;
    recent.forEach(function (sc) {
      Object.keys(sc.rates || {}).forEach(function (k) {
        var r = sc.rates[k];
        if (r === null || r === undefined || r === '') return;
        var v = Number(r);
        if (!isFinite(v) || v < 0 || v > 1) return;
        sum += (1 - v); n++;
      });
    });
    return n ? sum / n : C.defaultErrorRate;
  }

  function moodFactor(state, todayKey) {
    var keys = Object.keys(state.days || {}).filter(function (k) {
      return (!todayKey || k <= todayKey) && state.days[k].mood;
    }).sort();
    if (!keys.length) return { factor: 1, samples: 0, avg: 0, latest: '', on: null };

    /* 只看最近一次选的感受，不做滚动平均。
     * 平均的话会出现"我明明选了刚好，怎么还给我减量"——
     * 因为前几天选的累还在拉低平均值，用户的直觉理解不了。 */
    var lastKey = keys[keys.length - 1];
    var last = state.days[lastKey].mood;
    var score = YT.MOOD_SCORE[last] || 0;
    var factor = 1 + score * T(state.profile, 'moodWeight');
    factor = Math.max(C.moodFactorMin, Math.min(C.moodFactorMax, factor));

    return {
      factor: Math.round(factor * 1000) / 1000,
      samples: 1,
      avg: score,
      latest: last,
      on: lastKey,
    };
  }

  /* 某一天该按什么系数来排——依据是它前一周的实际完成情况。
   * 两条保护：前一周还没真正过完，或者压根没数据，都不调整。
   * 否则会出现"提前排下周时，把还没发生的未完成当成失败"这种乌龙。 */
  function reflowForDate(state, dateKey, todayKey) {
    var prevWeek = toKey(addDays(parseKey(weekKeyOf(dateKey)), -7));
    if (todayKey) {
      var prevWeekEnd = toKey(addDays(parseKey(prevWeek), 6));
      if (prevWeekEnd >= todayKey) {
        return { factor: 1, rule: null, ws: null, weekKey: prevWeek };
      }
    }
    var r = computeReflow(state, prevWeek);
    if (!r.ws || !r.ws.planned) {
      return { factor: 1, rule: null, ws: r.ws, weekKey: prevWeek };
    }
    return { factor: r.factor, rule: r.rule, ws: r.ws, weekKey: prevWeek };
  }

  /* 跨进新的一周时，把本周"还没动过"的日子清掉，
   * 让它们按上一周的实际表现重新排。已经打过卡的部分一律保留。 */
  function rollWeek(state, todayKey) {
    var wk = weekKeyOf(todayKey);
    state.weekMark = state.weekMark || {};
    if (state.weekMark[wk]) return { changed: false, ws: null, weekKey: null, rule: null };

    var prevWeek = toKey(addDays(parseKey(wk), -7));
    var r = computeReflow(state, prevWeek);
    var changed = false;

    if (r.ws && r.ws.planned) {
      Object.keys(state.days).forEach(function (k) {
        if (k < todayKey || weekKeyOf(k) !== wk) return;
        var day = state.days[k];
        if (day.isRest) return;
        var touched = day.mood || (day.tasks || []).some(function (t) {
          return t.status !== 'todo';
        });
        if (!touched) { delete state.days[k]; changed = true; }
      });
    }

    state.weekMark[wk] = true;
    return { changed: changed, rule: r.rule, factor: r.factor, ws: r.ws, weekKey: prevWeek };
  }

  /* 把某个学习日没做完的任务顺延到后面的学习日，超过容量的直接砍掉 */
  function carryOver(state, fromKey, uptoStudyDays) {
    var profile = state.profile;
    var day = state.days[fromKey];
    if (!day || day.isRest) return [];

    /* 只顺延听课。听课是有顺序的，落下一节后面的接不上；
     * 刷题和申论是弹性的，今天没做就过去了——补回来只是在堆任务，
     * 而堆任务正是让备考的人放弃的原因。 */
    var pending = (day.tasks || []).filter(function (t) {
      return t.status === 'todo' && t.kind === 'course' && !t.noSeq;
    });
    if (!pending.length) return [];

    var moved = [];
    var d = addDays(parseKey(fromKey), 1);
    var studySeen = 0;
    var guard = 0;

    while (studySeen < uptoStudyDays && pending.length && guard < 60) {
      guard++;
      var k = toKey(d);
      if (profile.examDate && k > profile.examDate) break;
      if (isRest(d, profile)) { d = addDays(d, 1); continue; }
      studySeen++;

      var target = state.days[k];
      if (!target) { d = addDays(d, 1); continue; }

      var cap = budgetFor(d, profile, target.stage);
      var used = (target.tasks || []).reduce(function (s, t) { return s + t.minutes; }, 0);
      var room = Math.round(cap.total * C.carryOverCap) - used;

      while (pending.length && room > 0) {
        var t = pending.shift();
        if (t.minutes <= room) {
          room -= t.minutes;
          var copy = JSON.parse(JSON.stringify(t));
          copy.id = nextId(k);
          copy.carried = true;
          copy.originDate = fromKey;
          target.tasks.push(copy);
          moved.push({ task: t, to: k });
        } else {
          break;
        }
      }
      d = addDays(d, 1);
    }

    var dropped = pending.map(function (t) { return { task: t, to: null }; });
    return moved.concat(dropped);
  }

  YT.engine = {
    toKey: toKey,
    parseKey: parseKey,
    addDays: addDays,
    dayDiff: dayDiff,
    weekKeyOf: weekKeyOf,
    isRest: isRest,
    isWeekend: isWeekend,
    countStudyDays: countStudyDays,
    buildRoadmap: buildRoadmap,
    stageOf: stageOf,
    stageProgress: stageProgress,
    budgetFor: budgetFor,
    courseProgress: courseProgress,
    currentCourseModule: currentCourseModule,
    targetUnits: targetUnits,
    effectiveLesson: effectiveLesson,
    studyableModules: studyableModules,
    strengthFactor: strengthFactor,
    buildTasks: buildTasks,
    lessonLabel: lessonLabel,
    ensureAhead: ensureAhead,
    dayStats: dayStats,
    weekStats: weekStats,
    reflowRule: reflowRule,
    computeReflow: computeReflow,
    moodFactor: moodFactor,
    errorRateFor: errorRateFor,
    lastActiveKey: lastActiveKey,
    restartInfo: restartInfo,
    missedStudyDays: missedStudyDays,
    applyRestart: applyRestart,
    reflowForDate: reflowForDate,
    rollWeek: rollWeek,
    carryOver: carryOver,
  };
})(window.YT);
