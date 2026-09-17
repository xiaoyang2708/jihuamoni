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

  /* 每个模块的"每题耗时"统计表
   * 只采信：刷题类任务 + 状态为完成 + 填了实际用时 + 题量大于 0 */
  function moduleTiming(state) {
    var buckets = {};
    YT.MODULES.forEach(function (m) {
      buckets[m.id] = { moduleId: m.id, name: m.name, short: m.short, samples: [], byStage: {} };
    });

    Object.keys(state.days || {}).forEach(function (k) {
      var day = state.days[k];
      (day.tasks || []).forEach(function (t) {
        if (t.kind !== 'practice') return;
        if (t.status !== 'done') return;
        if (!t.actualMinutes || !t.amount) return;
        var b = buckets[t.moduleId];
        if (!b) return;
        var per = t.actualMinutes / t.amount;
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
    var planned = 0, done = 0, actual = 0, daysStudied = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      if (todayKey && k > todayKey) return;
      var day = state.days[k];
      if (day.isRest) return;
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

  YT.stats = {
    median: median,
    moduleTiming: moduleTiming,
    streak: streak,
    overall: overall,
    recentRate: recentRate,
  };
})(window.YT);
