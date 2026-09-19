/* =========================================================================
 * demo.js —— 体验模式（发布前整块删掉，跟正式功能没有任何关系）
 *
 * 怎么开：网址后面加 ?demo=1
 *         比如 https://xiaoyang2708.github.io/jihuamoni/?demo=1
 *         本地就是 http://localhost:5173/?demo=1（或者双击 启动体验模式.bat）
 *         这样开过一次就记住了：之后打开普通网址、换个标签、刷新，工具条都还在。
 *         想彻底退出，点工具条最下面的「退出体验模式」——它会连这个记忆一起清掉。
 *
 * 干什么用：让朋友不用真的等三十天，就能看到跨周重排、任务顺延、断更重启、
 *          阶段推进跑出来是什么样。所有推进走的都是引擎里的真实逻辑，
 *          不是另外造一套假数据。
 *
 * ---------------------------------------------------------------------
 * 【正式上架时怎么删干净】一共四处，删完不留痕：
 *   1. 删掉这个文件 js/demo.js
 *   2. index.html 里删掉 <script src="js/demo.js"></script> 那一行
 *   3. css/styles.css 里删掉最后标了「体验模式」的那一段
 *   4. js/app.js 里搜「体验模式」，删掉标了记号的四处：
 *        demoCtx() 那一段、demoOn()、renderToday 里的 demoBar、
 *        render() 里的 decorate 调用
 *   剩下来的就是干干净净的正式版。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  var E = YT.engine;
  var DEFAULT_RATE = 0.75;
  var KEY = 'yang-toolbox/demo';     // 只记"体验模式开着没有"，不碰用户数据

  /* ---------------------------------------------------------------------
   * 开关：网址上带 ?demo=1，或者之前这么开过一次
   *
   * 为什么两种都认：只认网址的话，你换个标签、从收藏夹打开、或者点了一次
   * 「退出」，工具就没了，还得自己记得把 ?demo=1 加回去——评审阶段天天要用。
   * 所以记住它，但退出按钮会把这个记忆一起清掉，退出就是真退出。
   * ------------------------------------------------------------------- */

  function setFlag(on) {
    try {
      if (on) window.localStorage.setItem(KEY, '1');
      else window.localStorage.removeItem(KEY);
    } catch (e) { /* 无痕模式之类，忽略 */ }
  }

  var memo = null;    // 每次渲染都要问一次，别每次都去读 localStorage

  function enabled() {
    if (typeof YT.demoCtx !== 'function') return false;   // 正式版把 demo.js 删了就永远是 false
    if (memo !== null) return memo;
    if (/(^|[?&])demo=1(&|$)/.test(String(location.search || ''))) {
      setFlag(true);
      return (memo = true);
    }
    try { return (memo = window.localStorage.getItem(KEY) === '1'); }
    catch (e) { return (memo = false); }
  }

  function ctx() { return YT.demoCtx(); }

  /* ---------------------------------------------------------------------
   * 小工具
   * ------------------------------------------------------------------- */

  function fmtShort(key) {
    var d = E.parseKey(key);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function wdName(key) { return '日一二三四五六'[E.parseKey(key).getDay()]; }

  /* 计划开始到现在第几天。算不出来就返回 0，界面上不显示。 */
  function dayIndex(st, key) {
    /* 取最早的记录，而不是只看 roadmap.startKey——
     * 中途重排过计划的话 startKey 会变成"重排那天"，
     * 明明走到第 60 天了却显示"第 1 天"。 */
    var keys = Object.keys(st.days || {}).sort();
    var start = keys.length ? keys[0] : null;
    var rs = st.roadmap && st.roadmap.startKey;
    if (rs && (!start || rs < start)) start = rs;
    if (!start) return 0;
    return E.dayDiff(start, key) + 1;
  }

  function rateOf(st) {
    var v = st.ui && st.ui.demoRate;
    return (v === undefined || v === null) ? DEFAULT_RATE : Number(v);
  }

  /* 固定种子的随机数：同样的操作重复一遍，结果一样，方便对照 */
  function makeRnd(seed) {
    var s = seed || 20260918;
    return function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /* 把上一次"模拟"留下的那一条退回去，好按新的完成率重来。
   * 只退模拟打的卡；用户自己点的不动——那是他真的点过的。
   * 不退的话会有个很别扭的现象：先把完成率调到「全部完成」再点一次，
   * 上次"半完成"的那几项纹丝不动，按钮像是坏的。 */
  function undoSim(t) {
    var log = t.log || [];
    if (!log.length || !log[log.length - 1].demo) return;
    log.pop();
    t.status = log.length ? log[log.length - 1].status : 'todo';
    t.actualMinutes = null;
  }

  /* 按完成率造一天的打卡记录 */
  function simulateDay(day, rate, rnd, c) {
    if (!day || day.isRest) return;
    (day.tasks || []).forEach(function (t) {
      if (t.skip) return;
      undoSim(t);
      if (t.status && t.status !== 'todo') return;
      var r = rnd();
      if (rate >= 1 || r < rate) {
        c.setTaskStatus(t, 'done', { demo: true });
        if (rnd() < 0.6) {
          t.actualMinutes = Math.max(1, Math.round(t.minutes * (0.75 + rnd() * 0.5)));
        }
      } else if (r < rate + 0.12) {
        c.setTaskStatus(t, 'half', { demo: true });
      }
    });
    /* 感受跟完成情况挂钩：做得顺就是轻松，做不动就是累 */
    var r2 = rnd();
    if (rate < 0.6) day.mood = r2 < 0.5 ? 'hard' : 'tired';
    else if (rate > 0.9) day.mood = r2 < 0.5 ? 'easy' : 'ok';
    else day.mood = r2 < 0.4 ? 'ok' : (r2 < 0.7 ? 'tired' : 'easy');
  }

  /* 往回走的时候，把这周和以后的"已经重排过"标记清掉。
   * 不清的话，再往前走一遍时周重排不会重新算，
   * 用户改完过去的数据也看不到任何变化——那这个体验就是假的。 */
  function clearWeeksFrom(st, key) {
    var from = E.weekKeyOf(key);
    Object.keys(st.weekMark || {}).forEach(function (w) {
      if (w >= from) delete st.weekMark[w];
    });
  }

  /* ---------------------------------------------------------------------
   * 界面：今日页顶上那条
   * ------------------------------------------------------------------- */

  function bar() {
    var c = ctx();
    var st = c.getState();
    if (!st.profile) return '';

    var tk = c.todayKey();
    var real = c.realTodayKey();
    var sim = !!st.simDate;
    var idx = dayIndex(st, tk);
    var rate = rateOf(st);
    var more = !!(st.ui && st.ui.demoMore);

    function rateChip(v, label) {
      return '<button class="chip ' + (rate === v ? 'on' : '') +
        '" data-act="demo-rate" data-v="' + v + '">' + label + '</button>';
    }

    var moreHtml = !more ? '' :
      '<div class="demo-body">' +
        '<div class="demo-label">模拟完成率</div>' +
        '<div class="chips">' +
          rateChip(1, '全部完成') + rateChip(0.95, '95%') +
          rateChip(0.75, '75%') + rateChip(0.5, '50%') +
        '</div>' +

        '<div class="demo-label">一次往前跑几天</div>' +
        '<div class="chips">' +
          '<button class="chip" data-act="demo-run" data-v="7">自动跑 7 天</button>' +
          '<button class="chip" data-act="demo-run" data-v="30">30 天</button>' +
          '<button class="chip" data-act="demo-skip" data-v="5">停 5 天没学</button>' +
          '<button class="chip" data-act="demo-skip" data-v="12">停 12 天</button>' +
        '</div>' +

        '<div class="demo-label">跳到某一天</div>' +
        (st.profile.examDate
          ? '<div class="chips">' +
              '<button class="chip" data-act="demo-jump" data-v="exam-7">跳到考试前 7 天</button>' +
              '<button class="chip" data-act="demo-jump" data-v="exam">跳到考试日</button>' +
            '</div>'
          : '') +
        '<input class="demo-pick" type="date" data-act="demo-goto" value="' + tk + '"' +
          (st.roadmap && st.roadmap.startKey ? ' min="' + st.roadmap.startKey + '"' : '') +
          (st.profile.examDate ? ' max="' + st.profile.examDate + '"' : '') + '>' +
        '<div class="demo-note" style="margin-top:6px">' +
          '日历是系统自带的控件，个别内置浏览器点开会崩——崩了就刷新页面，数据不会丢。' +
        '</div>' +

        '<div class="demo-label">不满意就重来</div>' +
        '<div class="chips">' +
          '<button class="chip" data-act="demo-rewind">从这天重来</button>' +
          '<button class="chip" data-act="demo-restart">重新开始（回到问卷）</button>' +
        '</div>' +

        '<div class="demo-note">' +
          '「从这天重来」会把这一天的记录留着，后面几天的删掉重新往下排。' +
          '想试"如果我第三天没完成会怎么样"，就用它。' +
        '</div>' +
        '<button class="demo-off" data-act="demo-off">退出体验模式</button>' +
      '</div>';

    return '<div class="demo-bar">' +
      '<div class="demo-top">' +
        '<span class="demo-tag">体验模式</span>' +
        '<span class="demo-date">' + fmtShort(tk) + ' 周' + wdName(tk) +
          (idx > 0 ? ' · 第 ' + idx + ' 天' : '') + '</span>' +
        (sim ? '<button class="demo-real" data-act="demo-today">真实今天 ' + fmtShort(real) + '</button>' : '') +
      '</div>' +

      '<div class="demo-main">' +
        '<button class="btn sm" data-act="demo-prev">← 前一天</button>' +
        '<button class="btn sm primary" data-act="demo-fill">模拟完成今天</button>' +
        '<button class="btn sm" data-act="demo-next">下一天 →</button>' +
      '</div>' +

      '<button class="demo-toggle" data-act="demo-more">' +
        (more ? '收起 ▲' : '更多模拟选项 ▼') +
      '</button>' +

      moreHtml +
    '</div>';
  }

  /* 不在今日页的时候挂一个小标，提醒"你现在看的是模拟日期"。
   * 不挂的话，朋友在计划页、统计页看到的是几个月后的数据，会以为自己眼花了。 */
  function decorate() {
    var c = ctx();
    var st = c.getState();
    if (!st.profile || !st.simDate) return;
    if ((st.ui.screen || 'today') === 'today') return;
    var host = document.getElementById('app');
    if (!host) return;
    var el = document.createElement('button');
    el.className = 'demo-pill';
    el.setAttribute('data-act', 'demo-open');
    el.textContent = '体验模式 · ' + fmtShort(c.todayKey()) + ' · 回今日';
    host.appendChild(el);
  }

  /* ---------------------------------------------------------------------
   * 动作
   * ------------------------------------------------------------------- */

  function move(delta) {
    var c = ctx(), st = c.getState();
    var tk = c.todayKey();
    var next = E.toKey(E.addDays(E.parseKey(tk), delta));
    var start = (st.roadmap && st.roadmap.startKey) || tk;
    var end = st.profile.examDate;
    if (delta < 0 && next < start) return c.toast('已经是计划第一天了');
    if (delta > 0 && end && next > end) return c.toast('已经是考试日了，再往后没有计划');

    if (delta < 0) {
      /* 往回走不跑 dailyRoll——不做顺延、不重排，只是"回去看看"。
       * 改动完再往前走的时候，重排才会按新数据重新算。 */
      clearWeeksFrom(st, next);
      st.simDate = next;
      c.save();
      c.render();
      return;
    }

    st.simDate = next;
    c.dailyRoll();            // 和真实用户第二天打开 App 走同一条路径
    c.save();
    c.go('today');
  }

  function gotoDate(key) {
    var c = ctx(), st = c.getState();
    if (!key || key === c.todayKey()) return;
    var start = (st.roadmap && st.roadmap.startKey) || null;
    var end = st.profile.examDate;
    if (start && key < start) return c.toast('计划第一天是 ' + start);
    if (end && key > end) return c.toast('考试日是 ' + end + '，再往后就没有计划了');

    if (key < c.todayKey()) {
      clearWeeksFrom(st, key);
      st.simDate = key;
      c.save();
      c.render();
      c.toast('回到 ' + fmtShort(key) + '。在这天改完，再往前走一遍就会按新数据重排。');
      return;
    }
    st.simDate = key;
    c.dailyRoll();
    c.save();
    c.go('today');
  }

  function fillToday() {
    var c = ctx(), st = c.getState();
    var tk = c.todayKey();
    var day = st.days[tk];
    if (!day) return c.toast('这天没有任务');
    if (day.isRest) return c.toast('这天是休息日');

    var rate = rateOf(st);
    simulateDay(day, rate, makeRnd(20260918 + dayIndex(st, tk) * 13), c);
    c.regenFuture(tk);        // 跟真实"选感受"一样，立刻按今天的状态重排后面
    c.save();
    c.render();

    var tasks = day.tasks || [];
    var done = tasks.filter(function (t) { return t.status === 'done'; }).length;
    c.toast('今天模拟完成 ' + done + ' / ' + tasks.length + ' 项');
  }

  function runDays(n) {
    var c = ctx(), st = c.getState();
    var rnd = makeRnd(20260918 + n * 31);
    var rate = rateOf(st);
    var end = st.profile.examDate;
    var cursor = E.parseKey(c.todayKey());
    var ran = 0;

    for (var i = 0; i < n; i++) {
      var key = E.toKey(cursor);
      if (end && key > end) break;
      st.simDate = key;
      c.dailyRoll();
      var day = st.days[key];
      if (day && !day.isRest) { simulateDay(day, rate, rnd, c); ran++; }
      cursor = E.addDays(cursor, 1);
    }
    c.save();
    c.go('today');
    c.toast('已经自动跑完 ' + ran + ' 天，每天按 ' + Math.round(rate * 100) + '% 完成');
  }

  /* 断更：直接跳到"上次学习结束 N 天之后"，让回来那天的学习档案自然弹出来。
   * 既然是"停 N 天没学"，那这段时间的记录就都不算数了，先清掉再跳。
   * 不清的话，之前快进留下的打卡会让回来这天显成"已经学过了"，
   * 学习档案不会弹出来——按钮上的字和实际发生的事对不上。 */
  function skipDays(n) {
    var c = ctx(), st = c.getState();
    var tk = c.todayKey();
    var tomorrow = E.toKey(E.addDays(E.parseKey(tk), 1));
    var last = E.lastActiveKey(st, tomorrow) || tk;
    var target = E.toKey(E.addDays(E.parseKey(last), n));
    if (st.profile.examDate && target > st.profile.examDate) {
      return c.toast('再往后就超过考试日了，先往回走几天再试');
    }
    Object.keys(st.days || {}).forEach(function (k) {
      if (k > last) delete st.days[k];
    });
    clearWeeksFrom(st, last);
    st.simDate = target;
    st.ui.restartSeenOn = null;      // 让学习档案重新弹一次
    c.dailyRoll();
    c.save();
    c.go('today');
    c.toast('已经跳到停更 ' + n + ' 天之后');
  }

  function rewind() {
    var c = ctx(), st = c.getState();
    var tk = c.todayKey();
    var later = Object.keys(st.days || {}).filter(function (k) { return k > tk; }).length;
    c.askConfirm('从这天重来？',
      '这之后的 ' + later + ' 天记录会删掉，然后从 ' + fmtShort(tk) +
      ' 重新往下排。这天和之前的记录都留着。',
      function () {
        Object.keys(st.days).forEach(function (k) { if (k > tk) delete st.days[k]; });
        clearWeeksFrom(st, tk);
        if (st.days[tk]) st.days[tk].rolled = false;
        c.dailyRoll();
        c.save();
        c.go('today');
        c.toast('好了，从 ' + fmtShort(tk) + ' 重新往下排');
      });
  }

  function restart() {
    var c = ctx();
    c.askConfirm('重新开始？',
      '所有计划、打卡记录和统计都会删掉，然后回到问卷第一页。',
      function () {
        c.hardReset();
        c.toast('已经回到最开始，可以重新走一遍问卷');
      });
  }

  function backToToday() {
    var c = ctx(), st = c.getState();
    st.simDate = null;
    st.ui.restartSeenOn = null;
    c.dailyRoll();
    c.save();
    c.go('today');
    c.toast('已回到真实今天');
  }

  function disable() {
    var c = ctx(), st = c.getState();
    setFlag(false);
    memo = false;
    try {
      var params = new URLSearchParams(location.search);
      params.delete('demo');
      var q = params.toString();
      window.history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    } catch (e) { /* 忽略 */ }
    st.simDate = null;
    st.ui.screen = 'today';
    c.dailyRoll();
    c.save();
    c.go('today');
    c.toast('已退出体验模式，现在是正式版的样子');
  }

  function handle(act, el) {
    var c = ctx(), st = c.getState();
    if (act === 'demo-prev')   return move(-1);
    if (act === 'demo-next')   return move(1);
    if (act === 'demo-fill')   return fillToday();
    if (act === 'demo-today')  return backToToday();
    if (act === 'demo-open')   return c.go('today');
    if (act === 'demo-off')    return disable();
    if (act === 'demo-rewind') return rewind();
    if (act === 'demo-restart') return restart();
    if (act === 'demo-run')    return runDays(Number(el.getAttribute('data-v')) || 7);
    if (act === 'demo-skip')   return skipDays(Number(el.getAttribute('data-v')) || 5);
    if (act === 'demo-jump') {
      var end = st.profile.examDate;
      if (!end) return c.toast('还没填考试日期');
      var to = el.getAttribute('data-v') === 'exam'
        ? end
        : E.toKey(E.addDays(E.parseKey(end), -7));
      return gotoDate(to);
    }
    if (act === 'demo-more') {
      st.ui.demoMore = !st.ui.demoMore;
      c.save();
      return c.render();
    }
    if (act === 'demo-rate') {
      st.ui.demoRate = Number(el.getAttribute('data-v'));
      c.save();
      return c.render();
    }
  }

  /* 自己监听，app.js 里不用再加钩子。app.js 那边遇到不认识的 data-act 会直接放过。 */
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act') || '';
    if (act.indexOf('demo-') !== 0) return;
    if (!enabled()) return;
    /* 日历控件必须放过：它要的就是浏览器的默认行为（弹出日期选择器）。
     * 这里千万别调 ev.preventDefault()，一调整个控件就点不动了——这个坑踩过一次。 */
    if (act === 'demo-goto') return;
    handle(act, el);
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-act="demo-goto"]') : null;
    if (!el || !enabled()) return;
    gotoDate(el.value);
  });

  YT.demo = {
    enabled: enabled,
    bar: bar,
    decorate: decorate,
  };
})(window.YT);
