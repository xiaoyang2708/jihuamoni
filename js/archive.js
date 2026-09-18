/* =========================================================================
 * archive.js —— 学习档案
 *
 * 回答两个问题：
 *   1. 我到底学到哪了？（不是"你欠了多少"，是"你已经做完了什么"）
 *   2. 断了这么多天，从哪儿接上？
 *
 * 这一层不碰网页，跟 engine 一样是纯逻辑。将来搬去小程序直接搬。
 * 所有数字都是从 days 里算出来的，不额外存——存了就有两个真相。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  /* "第 3 节听到一半"比"该复习判断推理"有用得多 */
  function lessonWhere(done) {
    if (done <= 0.001) return '还没开始';
    var whole = Math.floor(done + 0.001);
    var half = (done - whole) > 0.001;
    if (half) return '第 ' + (whole + 1) + ' 节听到一半';
    return '已听完 ' + whole + ' 节';
  }

  /* 积少成多，半完成的按一半算 */
  function credit(status) {
    if (status === 'done') return 1;
    if (status === 'half') return 0.5;
    return 0;
  }

  /* 每个模块最近一次录入的正确率（没录过的没有这个键） */
  function latestRates(state) {
    var out = {};
    (state.scores || []).forEach(function (sc) {
      Object.keys(sc.rates || {}).forEach(function (k) {
        var v = sc.rates[k];
        if (v === null || v === undefined || v === '') return;
        var n = Number(v);
        if (isFinite(n)) out[k] = n;
      });
    });
    return out;
  }

  /* ---------------------------------------------------------------------
   * 主体：把散在每天里的打卡记录，汇成一份"学习档案"
   * ------------------------------------------------------------------- */

  function build(state, todayKey, stage) {
    var E = YT.engine;
    var profile = state.profile || {};
    var prog = E.courseProgress(state);

    var lastAny = null;
    var lastBy = {};   // 每个模块最后一次碰是什么时候
    var qBy = {};      // 累计做了多少题
    var gBy = {};      // 累计做了多少组
    var papers = 0;

    Object.keys(state.days || {}).sort().forEach(function (k) {
      if (todayKey && k > todayKey) return;
      var day = state.days[k];
      if (!day || day.isRest) return;
      (day.tasks || []).forEach(function (t) {
        var cr = credit(t.status);
        if (!cr) return;
        lastAny = k;
        if (!lastBy[t.moduleId] || k > lastBy[t.moduleId]) lastBy[t.moduleId] = k;
        if (t.kind === 'practice') {
          qBy[t.moduleId] = (qBy[t.moduleId] || 0) + (t.amount || 0) * cr;
          gBy[t.moduleId] = (gBy[t.moduleId] || 0) + (t.amounts || 0) * cr;
        } else if (t.kind === 'essay') {
          qBy.slw = (qBy.slw || 0) + (t.amounts || 1) * cr;
          gBy.slw = (gBy.slw || 0) + (t.amounts || 1) * cr;
        } else if (t.kind === 'paperset') {
          papers += cr;
        }
      });
    });

    /* ---- 听课进度：每个模块还剩几节 ---- */
    var courses = YT.MODULES.map(function (m) {
      var need = E.targetUnits(m, profile);
      var done = Math.min(need, prog[m.id] || 0);
      return {
        id: m.id,
        short: m.short,
        name: m.name,
        essay: !!m.essay,
        need: need,
        done: Math.round(done * 10) / 10,
        lessonText: lessonWhere(done),
        lastKey: lastBy[m.id] || null,
      };
    }).filter(function (c) { return c.need > 0.001; });

    /* ---- 刷题累计 ---- */
    var practices = YT.MODULES.filter(function (m) { return !m.essay; }).map(function (m) {
      var last = lastBy[m.id] || null;
      return {
        id: m.id,
        short: m.short,
        name: m.name,
        questions: Math.round(qBy[m.id] || 0),
        groups: Math.round((gBy[m.id] || 0) * 10) / 10,
        lastKey: last,
        gap: (last && todayKey) ? E.dayDiff(last, todayKey) : null,
      };
    }).filter(function (p) { return p.questions > 0; });

    var questionTotal = 0;
    Object.keys(qBy).forEach(function (k) { questionTotal += qBy[k]; });

    /* ---- 建议先回顾这些 ----
     * 这里是**完整清单**，由界面决定哪几条放"今天先做"、剩下的折叠起来。
     * 每个模块最多出一条，按这个优先级：
     *   听到一半的课 → 太久没练的 → 正确率没到目标的
     *
     * 注意给的是"回顾"，不是"接着听新课"——新课今天已经排好了，
     * 再列一条等于让人一天听两节，而且两份内容还是一样的。 */
    var review = [];
    var used = {};
    var effLesson = E.effectiveLesson(profile);

    courses.filter(function (c) {
      return c.done > 0.001 && c.done < c.need - 0.001;
    }).sort(function (a, b) {
      return (b.lastKey || '') > (a.lastKey || '') ? 1 : -1;
    }).forEach(function (c) {
      used[c.id] = true;
      var since = (c.lastKey && todayKey) ? E.dayDiff(c.lastKey, todayKey) : null;
      review.push({
        kind: 'course',
        moduleId: c.id,
        moduleName: c.name,
        short: c.short,
        title: c.short + ' · 回顾上一节',
        detail: c.lessonText + (since ? '，隔了 ' + since + ' 天' : '') + '，先把笔记过一遍',
        units: 1,
        minutes: Math.max(20, Math.round(effLesson * 0.25)),
      });
    });

    practices.filter(function (p) {
      return !used[p.id] && p.gap !== null && p.gap >= 5;
    }).sort(function (a, b) {
      return (b.gap || 0) - (a.gap || 0);
    }).forEach(function (p) {
      used[p.id] = true;
      var m = YT.MODULE_BY_ID[p.id];
      review.push({
        kind: 'practice',
        moduleId: p.id,
        moduleName: p.name,
        short: p.short,
        title: p.short + ' · 找手感',
        detail: '最后练是 ' + p.gap + ' 天前，先做 10 道',
        amount: 10,
        minutes: Math.max(10, Math.round(YT.unitMinutesFor(m, stage || 'base', profile) * 10)),
      });
    });

    /* 录过成绩的：低于目标 10 个百分点以上才算短板，不然天天挂着 */
    var rates = latestRates(state);
    practices.filter(function (p) {
      if (used[p.id]) return false;
      var r = rates[p.id];
      if (r === null || r === undefined) return false;
      var m = YT.MODULE_BY_ID[p.id];
      var tgt = YT.moduleParam(m, profile, 'targetRate');
      return tgt !== null && tgt !== undefined && r < tgt - 0.10;
    }).sort(function (a, b) {
      var ma = YT.MODULE_BY_ID[a.id], mb = YT.MODULE_BY_ID[b.id];
      var da = (YT.moduleParam(ma, profile, 'targetRate') || 0) - rates[a.id];
      var db = (YT.moduleParam(mb, profile, 'targetRate') || 0) - rates[b.id];
      return db - da;
    }).forEach(function (p) {
      used[p.id] = true;
      var m = YT.MODULE_BY_ID[p.id];
      var tgt = YT.moduleParam(m, profile, 'targetRate');
      var oneSet = p.questions > 0 ? '再刷一组' : '先刷一组';
      review.push({
        kind: 'practice',
        moduleId: p.id,
        moduleName: p.name,
        short: p.short,
        title: p.short + ' · 补短板',
        detail: '上次正确率 ' + Math.round(rates[p.id] * 100) + '%，目标 ' +
                Math.round(tgt * 100) + '%，' + oneSet,
        amount: m.setSize || 20,
        minutes: Math.max(20, Math.round(YT.unitMinutesFor(m, stage || 'base', profile) * (m.setSize || 20))),
      });
    });

    /* 一条都提不出来就不提。硬凑一条"开始听第 1 节"，
     * 跟今天的计划重复，等于让人一天听两节一样的课。 */

    var gap = (lastAny && todayKey) ? E.dayDiff(lastAny, todayKey) : null;

    return {
      everStudied: !!lastAny,
      lastKey: lastAny,
      gap: gap,
      courses: courses,
      courseTotal: {
        done: Math.round(courses.reduce(function (a, c) { return a + c.done; }, 0) * 10) / 10,
        need: Math.round(courses.reduce(function (a, c) { return a + c.need; }, 0) * 10) / 10,
      },
      practices: practices.sort(function (a, b) { return b.questions - a.questions; }),
      questionTotal: Math.round(questionTotal),
      papers: Math.round(papers * 10) / 10,
      review: review,
    };
  }

  YT.archive = {
    build: build,
    lessonWhere: lessonWhere,
    latestRates: latestRates,
  };
})(window.YT);
