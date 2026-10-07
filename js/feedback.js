/* =========================================================================
 * feedback.js —— 反馈事件层（很薄的一层）
 *
 * 只做一件事：把"用户做了什么"记成一条事件，再把事实整理成几句话。
 * 不存进度条、不存等级、不算上岸概率——那些是"评价"，不是"事实"。
 *
 * 本轮只把它渲染成文案和数据。将来接轻游戏化（积分、连击、成就）时，
 * 直接消费 events 这条流就行，不用回头动数据层。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  var MAX = 300;

  /* 事件类型。加新类型只在这里加一行，消费方按 type 认。 */
  var TYPES = {
    checkin: '打卡',
    done: '完成任务',
    goal: '达标',
    streak: '连续',
    progress: '进步',
  };

  function ensure(state) {
    if (!state.feedback || typeof state.feedback !== 'object') state.feedback = {};
    if (!Array.isArray(state.feedback.events)) state.feedback.events = [];
    return state.feedback;
  }

  /* 发一条事件。payload 里带上 date / taskId / moduleId 之类，
   * 消费方想怎么统计都行。事件只是流水，不做判断。 */
  function emit(state, type, payload) {
    if (!state) return null;
    var f = ensure(state);
    var ev = { type: type, at: new Date().toISOString() };
    if (payload) Object.keys(payload).forEach(function (k) { ev[k] = payload[k]; });
    f.events.push(ev);
    if (f.events.length > MAX) f.events = f.events.slice(-MAX);
    return ev;
  }

  function count(state, type) {
    var f = (state && state.feedback) || {};
    return (f.events || []).filter(function (e) { return e.type === type; }).length;
  }

  function last(state, type) {
    var f = (state && state.feedback) || {};
    var list = (f.events || []).filter(function (e) { return e.type === type; });
    return list.length ? list[list.length - 1] : null;
  }

  /* ---------------------------------------------------------------------
   * 事实型正反馈
   *
   * 只列"已经发生的事"，而且尽量带数字。不做进度条、不做上岸概率、
   * 不做等级徽章——那些是给人压力的，不是给人信心的。
   * ------------------------------------------------------------------- */

  function highlights(state, todayKey) {
    var E = YT.engine;
    var S = YT.stats;
    var out = [];
    if (!state || !todayKey) return out;

    /* 1）连续打卡 */
    var st = S.streak(state, todayKey);
    if (st >= 2) out.push({ kind: 'streak', text: '连续 ' + st + ' 天没断过' });

    /* 2）本周完成 */
    var wk = E.weekKeyOf(todayKey);
    var weekItems = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      if (E.weekKeyOf(k) !== wk || k > todayKey) return;
      var day = state.days[k];
      if (!day || day.isRest) return;
      (day.tasks || []).forEach(function (t) {
        var cr = t.status === 'done' ? 1 : t.status === 'half' ? 0.5 : 0;
        weekItems += cr;
      });
    });
    weekItems = Math.round(weekItems);
    if (weekItems > 0) out.push({ kind: 'week', text: '本周完成了 ' + weekItems + ' 项' });

    /* 3）正确率进步：最近两次记录里涨得最多的一科 */
    var byMod = {};
    (state.scores || []).forEach(function (sc) {
      Object.keys(sc.rates || {}).forEach(function (id) {
        var v = sc.rates[id];
        if (v === null || v === undefined || v === '') return;
        (byMod[id] = byMod[id] || []).push(Number(v));
      });
    });
    var bestRate = null;
    Object.keys(byMod).forEach(function (id) {
      var list = byMod[id];
      if (list.length < 2) return;
      var diff = list[list.length - 1] - list[list.length - 2];
      if (diff >= 0.03 && (!bestRate || diff > bestRate.diff)) {
        bestRate = { id: id, diff: diff, from: list[list.length - 2], to: list[list.length - 1] };
      }
    });
    if (bestRate) {
      var bm = YT.MODULE_BY_ID[bestRate.id];
      out.push({ kind: 'rate', text: (bm ? bm.short : '') + ' 正确率从 ' +
        Math.round(bestRate.from * 100) + '% 提到了 ' + Math.round(bestRate.to * 100) + '%' });
    }

    /* 4）限时进步：记录够多、且比现在的基准快 */
    var timing = S.moduleTiming(state);
    var fastest = null;
    timing.forEach(function (r) {
      if (r.samples < 5 || r.medianPerQuestion === null) return;
      var diff = r.current - r.medianPerQuestion;
      if (diff >= 0.3 && (!fastest || diff > fastest.diff)) fastest = { r: r, diff: diff };
    });
    if (fastest) {
      out.push({ kind: 'speed', text: fastest.r.short + ' 现在一题约 ' +
        (Math.round(fastest.r.medianPerQuestion * 10) / 10) + ' 分钟，比计划按的 ' +
        fastest.r.current + ' 分钟快了' });
    }

    /* 5）某个模块练过一轮 */
    var sets = E.moduleSets(state);
    var need = YT.CONFIG.levelSets || 12;
    var doneModule = null;
    Object.keys(sets).forEach(function (id) {
      if (doneModule) return;
      if (sets[id] >= need) {
        var m = YT.MODULE_BY_ID[id];
        if (m && !m.essay) doneModule = m.short;
      }
    });
    if (doneModule) out.push({ kind: 'round', text: doneModule + ' 已经练过一轮了' });

    /* 6）上次停在哪，这次接上了 */
    var live = (state.focus && state.focus.sessions) || [];
    if (live.length) {
      var lastS = live[live.length - 1];
      if (lastS && lastS.taskId && lastS.dateKey && state.days[lastS.dateKey]) {
        var hit = (state.days[lastS.dateKey].tasks || []).filter(function (t) {
          return t.id === lastS.taskId;
        })[0];
        if (hit && hit.status === 'done') {
          out.push({ kind: 'resume', text: '上次停下的「' + hit.title + '」这次接着完成了' });
        }
      }
    }

    /* 7）时间大头在哪：按标签的占比（结构型，不是"越多越好"）。
     * 未指定 / 自由专注不进分布，也不参与这里的占比。 */
    var byTag = S.subjectTime(state, todayKey);
    var tagTotal = 0;
    byTag.forEach(function (b) { tagTotal += b.total; });
    if (tagTotal >= 120 && byTag.length) {
      var top = byTag[0];
      var share = Math.round(top.total / tagTotal * 100);
      if (share >= 40) out.push({ kind: 'share', text: '时间大头在「' + top.name + '」：占 ' + share + '%' });
    }

    /* 8）估时越来越准：前后两段的平均偏差在收窄。
     * 这个指标灌水只会更难看——填大数字偏差反而变大，天然抗干扰。 */
    var pts = [];
    Object.keys(state.days || {}).sort().forEach(function (k) {
      if (k > todayKey) return;
      var day = state.days[k];
      if (!day || day.isRest) return;
      (day.tasks || []).forEach(function (t) {
        var plan = Number(t.minutes) || 0;
        var act = S.effectiveMinutes(t);
        if (plan > 0 && act > 0) pts.push(Math.abs(act - plan) / plan);
      });
    });
    if (pts.length >= 6) {
      var half = Math.floor(pts.length / 2);
      var avgOf = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
      var older = avgOf(pts.slice(0, half));
      var recent = avgOf(pts.slice(half));
      if (recent <= older - 0.05) {
        out.push({ kind: 'accuracy', text: '估时越来越准：偏差从 ±' +
          Math.round(older * 100) + '% 收到 ±' + Math.round(recent * 100) + '%' });
      }
    }

    return out.slice(0, 5);
  }

  YT.feedback = {
    TYPES: TYPES,
    ensure: ensure,
    emit: emit,
    count: count,
    last: last,
    highlights: highlights,
  };
})(window.YT);
