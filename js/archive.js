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

  /* 一轮备考的整体成绩。封存的时候算一次存下来，
   * 历史轮次就不用每次重新扫一遍几百天。 */
  function roundSummary(days, profile) {
    var E = YT.engine;
    var planned = 0, done = 0, questions = 0, studied = 0, papers = 0;
    var first = null, last = null;
    Object.keys(days || {}).forEach(function (k) {
      if (!first || k < first) first = k;
      if (!last || k > last) last = k;
      var day = days[k];
      if (!day || day.isRest) return;
      var st = E.dayStats(day);
      if (st.planned) { planned += st.planned; done += st.done; }
      if ((day.tasks || []).some(function (t) { return t.status !== 'todo'; })) studied++;
      (day.tasks || []).forEach(function (t) {
        var cr = credit(t.status);
        if (!cr) return;
        if (t.kind === 'practice') questions += (t.amount || 0) * cr;
        else if (t.kind === 'essay') questions += (t.amounts || 1) * cr;
        else if (t.kind === 'paperset') papers += cr;
      });
    });
    return {
      startKey: first,
      endKey: last,
      studiedDays: studied,
      planned: Math.round(planned),
      done: Math.round(done),
      rate: planned > 0 ? done / planned : 0,
      questions: Math.round(questions),
      papers: Math.round(papers * 10) / 10,
      course: E.courseProgress({ days: days, profile: profile }),
    };
  }

  /* 最近这些天里，用户自己加得最勤的是哪几科。
   * 只数"自己加的、不是回顾、不是主攻"的任务——那是他主动多要的。 */
  function selfAddedByModule(state, todayKey, lookDays) {
    var E2 = YT.engine;
    var d = E2.parseKey(todayKey);
    var hits = {};
    var seenDays = 0, guard = 0;
    while (seenDays < lookDays && guard < lookDays * 3 + 7) {
      guard++;
      var k = E2.toKey(d);
      d = E2.addDays(d, -1);   // 从今天开始往前数：今天加的那次也算
      var day = state.days[k];
      if (!day || day.isRest) continue;   // 只数学习日
      seenDays++;
      var seen = {};
      (day.tasks || []).forEach(function (t) {
        if (!t.userAdded || t.review || t.focus) return;
        seen[t.moduleId] = true;
      });
      /* 主动"换成这一科"也算——那是明确的"我想多练它" */
      (state.swapLog || []).forEach(function (x) {
        if (x.date === k) seen[x.to] = true;
      });
      Object.keys(seen).forEach(function (id) {
        hits[id] = hits[id] || { moduleId: id, days: 0, lastKey: null };
        hits[id].days++;
        if (!hits[id].lastKey || k > hits[id].lastKey) hits[id].lastKey = k;
      });
    }
    return Object.keys(hits).map(function (id) { return hits[id]; })
      .sort(function (a, b) { return b.days - a.days; });
  }

  /* ---------------------------------------------------------------------
   * 正确率驱动的建议（D7 + C7b）
   *
   * 有了成绩数据之后，系统能说点有依据的话，而不是"多练练"。
   * 四条规则，每条都必须带一个能点的动作——光说"你该加强资料"没用。
   * ------------------------------------------------------------------- */

  function pctText(v) { return Math.round(v * 100) + '%'; }

  function advice(state, todayKey) {
    var out = [];
    var scores = state.scores || [];
    if (!scores.length) return out;

    var profile = state.profile || {};
    /* 每个模块按时间顺序的成绩 */
    var byMod = {};
    scores.forEach(function (sc) {
      Object.keys(sc.rates || {}).forEach(function (id) {
        var v = sc.rates[id];
        if (v === null || v === undefined || v === '') return;
        (byMod[id] = byMod[id] || []).push({ date: sc.date, v: Number(v), src: sc.source || '' });
      });
    });

    Object.keys(byMod).forEach(function (id) {
      var m = YT.MODULE_BY_ID[id];
      if (!m || m.essay) return;
      var tgt = YT.moduleParam(m, profile, 'targetRate');
      if (tgt === null || tgt === undefined) return;   // 数量和常识没设目标，不猜

      var list = byMod[id];
      var last = list[list.length - 1];
      var cur = (profile.strength && profile.strength[id]) || 'normal';

      /* 1）明显低于目标，而且还没加强过 → 建议加强 */
      if (last.v < tgt - 0.10 && cur !== 'strong' && cur !== 'skip') {
        out.push({
          kind: 'strengthen', moduleId: id, short: m.short, action: 'set-strong',
          text: m.short + '最近一次 ' + pctText(last.v) + '，目标 ' + pctText(tgt) +
                '。差得有点多，要不要给它多排点题？',
        });
      }

      /* 2）稳定超过目标，但强度还挂着"加强" → 把时间让出来 */
      if (last.v >= tgt + 0.05 && cur === 'strong') {
        out.push({
          kind: 'lighten', moduleId: id, short: m.short, action: 'set-normal',
          text: m.short + '已经稳定在 ' + pctText(last.v) + '，超过目标 ' + pctText(tgt) +
                '。可以把它的时间让给别的科了。',
        });
      }

      /* 3）连着三次几乎没动，而且没到目标 → 可能是方法问题，不是熟练度问题 */
      if (list.length >= 3) {
        var last3 = list.slice(-3);
        var vals = last3.map(function (x) { return x.v; });
        var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
        if (mx - mn <= 0.04 && mx < tgt - 0.05) {
          out.push({
            kind: 'relisten', moduleId: id, short: m.short, action: null,
            text: m.short + '连着三次都在 ' + pctText(mx) + ' 附近没动。这多半不是练得少，' +
                  '是方法没对上——回去把这部分的课重听一遍，比再刷一百题管用。',
          });
        }
      }
    });

    /* 4）套卷里某一科明显掉链子 → 提议回炉（C7b） */
    var papers = scores.filter(function (sc) { return sc.source === '真题套卷'; });
    var lastPaper = papers[papers.length - 1];
    if (lastPaper) {
      Object.keys(lastPaper.rates || {}).forEach(function (id) {
        var m = YT.MODULE_BY_ID[id];
        if (!m || m.essay) return;
        var v = lastPaper.rates[id];
        if (v === null || v === undefined || v === '') return;
        v = Number(v);
        /* 跟平时比。平时 = 非套卷的记录 */
        var base = (byMod[id] || []).filter(function (x) { return x.src !== '真题套卷'; });
        if (base.length < 2) return;
        var avg = base.reduce(function (a, x) { return a + x.v; }, 0) / base.length;
        if (avg - v >= 0.15) {
          out.push({
            kind: 'backToSpecial', moduleId: id, short: m.short, action: 'boost',
            text: '这次套卷' + m.short + '只有 ' + pctText(v) + '，比平时低了 ' +
                  Math.round((avg - v) * 100) + ' 个点。要不要先回去练一阵专项，套卷往后放放？',
          });
        }
      });
    }

    /* 一次最多说三条，不然成了批斗会 */
    return out.slice(0, 3);
  }

  /* ---------------------------------------------------------------------
   * 模块档位（B 方案：只显示"你在哪一档"，不锁任何东西）
   *
   * 刻意不做成"达标才能升级"的门票：
   *   没录成绩 → 按练了多少组估档位（不录数据的人照样能往下走）
   *   录了成绩 → 按最近正确率算
   *   平台期   → 档位不会卡死，提示换成"该换练法了"（降档不等于惩罚）
   * ------------------------------------------------------------------- */

  var LEVEL_NAME = ['还没开始', '认识题型', '专项强化', '限时提速', '保持手感'];

  function moduleLevels(state, todayKey) {
    var E2 = YT.engine;
    var profile = state.profile || {};
    var sets = E2.moduleSets(state);
    var need = YT.CONFIG.levelSets || 12;

    /* 每个模块的正确率序列（按录入顺序） */
    var seq = {};
    (state.scores || []).forEach(function (sc) {
      Object.keys(sc.rates || {}).forEach(function (id) {
        var v = sc.rates[id];
        if (v === null || v === undefined || v === '') return;
        (seq[id] = seq[id] || []).push(Number(v));
      });
    });

    return YT.MODULES.filter(function (m) {
      /* 不学的模块不列出来 */
      return !m.essay && E2.targetUnits(m, profile) > 0;
    }).map(function (m) {
      var tgt = YT.moduleParam(m, profile, 'targetRate');
      var n = Math.round((sets[m.id] || 0) * 10) / 10;
      var list = seq[m.id] || [];
      var last = list.length ? list[list.length - 1] : null;
      var before = list.length > 1 ? list[list.length - 2] : null;
      var lv, note, gap = null;

      if (tgt === null || tgt === undefined) {
        /* 数量和常识：没设目标，只按练的量给个粗略档位 */
        lv = n > 0 ? (n >= need ? 2 : 1) : 0;
        note = '这科没设目标，按练的量走';
      } else if (last === null) {
        lv = n > 0 ? (n >= need ? 2 : 1) : 0;
        note = n > 0 ? '还没录过正确率，先按练的量走' : '还没开始练';
      } else if (last >= tgt + 0.05 && before !== null && before >= tgt + 0.05) {
        lv = 4;
        note = '连续两次稳在目标以上，做一组保持就行';
      } else if (last >= tgt) {
        lv = 3;
        gap = null;
        note = '已经到目标，可以开始压时间了';
      } else if (last >= tgt - 0.10) {
        lv = 2;
        gap = Math.round((tgt - last) * 100);
        note = '还差 ' + gap + ' 个点到 ' + Math.round(tgt * 100) + '%';
      } else {
        lv = 1;
        gap = Math.round((tgt - last) * 100);
        note = '离目标还有 ' + gap + ' 个点，先把题型认全、别急着掐表';
      }

      /* 练了很多组但正确率一直不动 → 这就是平台期，给一句实话 */
      if (list.length >= 3) {
        var l3 = list.slice(-3);
        var mx = Math.max.apply(null, l3), mn = Math.min.apply(null, l3);
        if (mx - mn <= 0.04 && tgt !== null && tgt !== undefined && mx < tgt) {
          note = '练了 ' + n + ' 组，正确率一直在 ' + Math.round(mx * 100) +
                 '% 附近——该换练法了（回去把课重听一遍，或者换批题），别再加量';
        }
      }

      return {
        moduleId: m.id,
        short: m.short,
        name: m.name,
        level: lv,
        levelName: LEVEL_NAME[lv],
        sets: n,
        lastRate: last,
        targetRate: (tgt === null || tgt === undefined) ? null : tgt,
        gap: gap,
        note: note,
      };
    });
  }

  YT.archive = {
    build: build,
    lessonWhere: lessonWhere,
    latestRates: latestRates,
    roundSummary: roundSummary,
    selfAddedByModule: selfAddedByModule,
    advice: advice,
    moduleLevels: moduleLevels,
    LEVEL_NAME: LEVEL_NAME,
  };
})(window.YT);
