/* =========================================================================
 * stats.js —— 统计
 * 只做两件事：算出"你自己做题到底要多久"，以及打卡的连续性指标。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  function median(arr) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /* 一条任务"真正学了多久"。
   *
   * 口径：自报实际 > 计时器专注 > 0。**预计时长永远不算**——
   * 那是计划，不是事实；用户随手填个 99999 也不该污染学习时长。
   * 计时器时长（focusMinutes）由番茄钟/正计时写入，是最可信的一层；
   * 自报实际（actualMinutes）在完成弹窗里确认，作为没计时时的兜底。 */
  function effectiveMinutes(t) {
    if (!t) return 0;
    var a = Number(t.actualMinutes);
    if (isFinite(a) && a > 0) return a;
    var f = Number(t.focusMinutes);
    if (isFinite(f) && f > 0) return f;
    return 0;
  }

  function sessionDay(s) {
    try { return YT.engine.toKey(new Date(s.startedAt)); } catch (e) { return null; }
  }

  /* 每个模块的"每题耗时"统计表
   * 只采信：刷题类任务 + 状态为完成 + 填了实际用时 + 题量大于 0 */
  function moduleTiming(state) {
    var E = YT.engine;
    var buckets = {};
    YT.MODULES.forEach(function (m) {
      buckets[m.id] = { moduleId: m.id, name: m.name, short: m.short, samples: [], byStage: {} };
    });

    Object.keys(state.days || {}).forEach(function (k) {
      var day = state.days[k];
      (day.tasks || []).forEach(function (t) {
        /* 自己排的清单条目只要带题量，也照样算进做题速度。 */
        var w = E.taskWork(t);
        if (!w || w.type !== 'practice') return;
        if (t.status !== 'done') return;
        if (!t.actualMinutes || !w.amount) return;
        var b = buckets[w.moduleId];
        if (!b) return;
        var per = t.actualMinutes / w.amount;
        if (!isFinite(per) || per <= 0 || per > 30) return; // 明显异常值丢掉
        b.samples.push({ per: per, date: k, stage: day.stage || '' });
      });
    });

    var benchmarks = (state.profile && state.profile.benchmarks) || {};

    return YT.MODULES.map(function (m) {
      var b = buckets[m.id];
      var pers = b.samples.map(function (s) { return s.per; });
      var med = median(pers);
      var current = benchmarks[m.id] !== undefined ? benchmarks[m.id] : m.unitMinutes;
      return {
        moduleId: m.id,
        name: m.name,
        short: m.short,
        samples: pers.length,
        medianPerQuestion: med,
        current: current,
        suggestion: (pers.length >= 5 && med !== null) ? Math.round(med * 10) / 10 : null,
      };
    });
  }

  /* 打卡连续性：休息日也算在内，不断连 */
  function streak(state, todayKey) {
    var E = YT.engine;
    var d = E.parseKey(todayKey);
    var n = 0;
    var guard = 0;

    var today = state.days[todayKey];
    var todayDone = today && !today.isRest && (today.tasks || []).some(function (t) {
      return t.status === 'done' || t.status === 'half';
    });

    /* 今天还没打卡就先从昨天往前算 */
    if (!todayDone) d = E.addDays(d, -1);

    while (guard < 400) {
      guard++;
      var k = E.toKey(d);
      var day = state.days[k];
      if (!day) break;
      if (day.isRest) { n++; d = E.addDays(d, -1); continue; }
      var touched = (day.tasks || []).some(function (t) {
        return t.status === 'done' || t.status === 'half';
      });
      if (!touched) break;
      n++;
      d = E.addDays(d, -1);
    }
    return n;
  }

  /* 总体：累计学习分钟、累计完成率。
   * 只算到今天为止——未来的日子还没开始，算进分母会把完成率压得很难看。 */
  function overall(state, todayKey) {
    var E = YT.engine;
    var manual = E.isManual(state.profile);
    var planned = 0, done = 0, actual = 0, daysStudied = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      if (todayKey && k > todayKey) return;
      var day = state.days[k];
      if (!day || day.isRest) return;
      /* 自己排：清单条目本身就是"计划"，没有系统排/自己加之分。 */
      if (manual) {
        var has = false, anyDone = false, mMin = 0, mDone = 0;
        (day.tasks || []).forEach(function (t) {
          has = true;
          /* planned 用预计时长（计划口径），done 用有效时长（事实口径）。 */
          mMin += Number(t.minutes) || 0;
          mDone += effectiveMinutes(t);
          if (t.status !== 'todo') anyDone = true;
        });
        if (!has) return;
        planned += mMin;
        done += mDone;
        actual += mDone;
        if (anyDone) daysStudied++;
        return;
      }
      var s = YT.engine.dayStats(day);
      if (!s.planned) return;
      planned += s.planned;
      done += s.done;
      (day.tasks || []).forEach(function (t) {
        if (t.status === 'done' && t.actualMinutes) actual += t.actualMinutes;
      });
      if ((day.tasks || []).some(function (t) { return t.status !== 'todo'; })) daysStudied++;
    });
    return {
      planned: planned,
      done: done,
      actual: actual,
      rate: planned > 0 ? done / planned : 0,
      daysStudied: daysStudied,
    };
  }

  /* 最近 n 个已经过去的学习日的完成率，用来给趋势判断 */
  function recentRate(state, todayKey, n) {
    var E = YT.engine;
    var d = E.addDays(E.parseKey(todayKey), -1);
    var planned = 0, done = 0, seen = 0, guard = 0;
    while (seen < n && guard < 120) {
      guard++;
      var k = E.toKey(d);
      var day = state.days[k];
      if (day && !day.isRest) {
        var s = E.dayStats(day);
        if (s.planned) { planned += s.planned; done += s.done; seen++; }
      }
      d = E.addDays(d, -1);
    }
    return planned > 0 ? done / planned : null;
  }

  /* ---------------------------------------------------------------------
   * 自己排：清单口径
   *
   * 这里回答的全是"我做了什么"，没有"系统排的量合不合适"——
   * 那条判断在自动/半自动里才有意义。
   * ------------------------------------------------------------------- */

  function checklistTotals(state, todayKey) {
    var items = 0, doneItems = 0, plannedMinutes = 0, actualMinutes = 0, selfMinutes = 0, days = 0;
    var bySubject = {};

    Object.keys(state.days || {}).sort().forEach(function (k) {
      if (todayKey && k > todayKey) return;
      var day = state.days[k];
      if (!day || day.isRest) return;
      var has = false, touched = false;
      (day.tasks || []).forEach(function (t) {
        has = true;
        var cr = t.status === 'done' ? 1 : t.status === 'half' ? 0.5 : 0;
        var plan = Number(t.minutes) || 0;
        var eff = effectiveMinutes(t);
        var self = Number(t.actualMinutes);
        items++;
        doneItems += cr;
        plannedMinutes += plan;
        actualMinutes += eff;
        if (isFinite(self) && self > 0) selfMinutes += self;
        if (t.status !== 'todo') touched = true;

        /* 标签：判推三块归一到「判断推理」；没标签的进 _other（只进总时长）。 */
        var mid = YT.tagIdOf(t.moduleId) || '_other';
        var b = bySubject[mid] ||
          (bySubject[mid] = { moduleId: mid, name: YT.tagNameOf(mid) || t.moduleName || '其他',
                              planned: 0, minutes: 0, doneMinutes: 0, items: 0, doneItems: 0 });
        b.planned += plan;
        b.minutes += eff;
        b.doneMinutes += plan * cr;
        b.items++;
        b.doneItems += cr;
      });
      if (has && touched) days++;
    });

    return {
      items: items,
      doneItems: Math.round(doneItems * 10) / 10,
      plannedMinutes: Math.round(plannedMinutes),
      actualMinutes: Math.round(actualMinutes),
      selfMinutes: Math.round(selfMinutes),
      minutes: Math.round(actualMinutes),   // 兼容旧字段名：分钟口径 = 有效时长
      doneMinutes: Math.round(actualMinutes),
      rate: items > 0 ? doneItems / items : 0,
      days: days,
      bySubject: Object.keys(bySubject).map(function (id) { return bySubject[id]; })
        .sort(function (a, b) { return (b.minutes - a.minutes) || (b.planned - a.planned) || (b.items - a.items); }),
    };
  }

  /* 某天"实际学了多久"：清单里各条的有效时长 + 没挂任务的自由专注。
   * 热力图和按天记录用它（预计时长不参与）。 */
  function dayStudyMinutes(state, key) {
    var m = 0;
    var day = state.days && state.days[key];
    ((day && day.tasks) || []).forEach(function (t) { m += effectiveMinutes(t); });
    var sessions = (state.focus && state.focus.sessions) || [];
    sessions.forEach(function (s) {
      if (s.taskId) return;              // 挂到任务的已经算在那条任务上了
      if (sessionDay(s) === key) m += Number(s.minutes) || 0;
    });
    return Math.round(m);
  }

  /* 计时器时长合计（含挂任务的和自由的）——最可信的一层。 */
  function timerMinutes(state, todayKey) {
    var sessions = (state.focus && state.focus.sessions) || [];
    var m = 0;
    sessions.forEach(function (s) {
      var d = sessionDay(s);
      if (todayKey && d && d > todayKey) return;
      m += Number(s.minutes) || 0;
    });
    return Math.round(m);
  }

  /* 估时准确度：有预计、也有实际用时的条目里，平均相对偏差。
   * 这个数字**越灌水越难看**——填大数字反而让偏差变大，天然抗干扰。 */
  function estimateAccuracy(state, todayKey) {
    var n = 0, sum = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      if (todayKey && k > todayKey) return;
      var day = state.days[k];
      if (!day || day.isRest) return;
      (day.tasks || []).forEach(function (t) {
        var plan = Number(t.minutes) || 0;
        var act = effectiveMinutes(t);
        if (plan > 0 && act > 0) {
          n++;
          sum += Math.abs(act - plan) / plan;
        }
      });
    });
    return { samples: n, bias: n ? sum / n : null };
  }

  /* 番茄钟记录汇总。sessions 里每条都是"真的结束过一次"的专注。 */
  function focusTotals(state, todayKey) {
    var E = YT.engine;
    var sessions = (state.focus && state.focus.sessions) || [];
    var minutes = 0, count = 0, pomodoros = 0, days = 0;
    var byDay = {}, bySubject = {};
    sessions.forEach(function (s) {
      var day = null;
      try { day = E.toKey(new Date(s.startedAt)); } catch (e) { day = null; }
      if (todayKey && day && day > todayKey) return;
      var mins = Number(s.minutes) || 0;
      minutes += mins;
      count++;
      /* "番茄个数"只数真正走完的那一个，中途停下的不算。 */
      if (s.mode === 'pomodoro' && s.completed) pomodoros++;
      if (day) {
        if (!byDay[day]) { byDay[day] = 0; days++; }
        byDay[day] += mins;
      }
      var mid = YT.tagIdOf(s.moduleId) || '_free';
      if (!bySubject[mid]) bySubject[mid] = { moduleId: mid, minutes: 0, count: 0 };
      bySubject[mid].minutes += mins;
      bySubject[mid].count++;
    });
    return {
      minutes: Math.round(minutes),
      count: count,
      pomodoros: pomodoros,
      days: days,
      byDay: byDay,
      bySubject: Object.keys(bySubject).map(function (id) { return bySubject[id]; })
        .sort(function (a, b) { return b.minutes - a.minutes; }),
    };
  }

  /* 单独某一天的专注：分钟 + 番茄个数。
   *
   * focusTotals 的口径是"到这天为止的累计"，它顺手返回的 byDay 只有分钟、
   * 没有番茄数。今日页和工具页要的是"今天"，所以这里从头遍历一遍，
   * 免得两个页面各自拿累计值当今天用（那就成了两个真相）。 */
  function focusToday(state, key) {
    var E = YT.engine;
    var sessions = (state.focus && state.focus.sessions) || [];
    var minutes = 0, pomodoros = 0, count = 0;
    sessions.forEach(function (s) {
      var day = null;
      try { day = E.toKey(new Date(s.startedAt)); } catch (e) { return; }
      if (day !== key) return;
      minutes += Number(s.minutes) || 0;
      count++;
      if (s.mode === 'pomodoro' && s.completed) pomodoros++;
    });
    return { minutes: Math.round(minutes), pomodoros: pomodoros, count: count };
  }

  /* 按科目的时间分布：清单里写的工作量 + 番茄钟专注，两处合并。
   * 用户想知道"我这周时间花在哪了"，这个数字比完成率有用。
   *
   * 刻意**不包含**没指定科目的时长（清单 `_other`、自由专注 `_free`）：
   * 它们不属于任何一科，混进来会让每科的数失真；但它们照样算进
   * checklistTotals / focusTotals / overall / 热力图的总时长。
   * 以后做按科目的正反馈时，取这里的数就是"已归科目的时长"。 */
  function subjectTime(state, todayKey) {
    var out = {};
    var c = checklistTotals(state, todayKey);
    c.bySubject.forEach(function (b) {
      if (b.moduleId === '_other') return;
      out[b.moduleId] = { moduleId: b.moduleId,
        name: YT.tagNameOf(b.moduleId) || b.name, minutes: b.minutes, focus: 0 };
    });
    var f = focusTotals(state, todayKey);
    f.bySubject.forEach(function (b) {
      if (b.moduleId === '_free') return;
      var cid = YT.tagIdOf(b.moduleId);
      var cur = out[cid] || (out[cid] = {
        moduleId: cid, name: YT.tagNameOf(cid) || '其他', minutes: 0, focus: 0 });
      cur.focus += b.minutes;
    });
    return Object.keys(out).map(function (id) {
      out[id].total = out[id].minutes + out[id].focus;
      return out[id];
    }).filter(function (b) {
      /* 只有真正花过时间的标签才进"时间花在哪"；0 小时的别占地方。 */
      return b.total > 0;
    }).sort(function (a, b) { return b.total - a.total; });
  }

  YT.stats = {
    median: median,
    effectiveMinutes: effectiveMinutes,
    dayStudyMinutes: dayStudyMinutes,
    timerMinutes: timerMinutes,
    estimateAccuracy: estimateAccuracy,
    moduleTiming: moduleTiming,
    streak: streak,
    overall: overall,
    recentRate: recentRate,
    checklistTotals: checklistTotals,
    focusTotals: focusTotals,
    focusToday: focusToday,
    subjectTime: subjectTime,
  };
})(window.YT);
