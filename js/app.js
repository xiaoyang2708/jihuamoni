/* =========================================================================
 * app.js —— 界面与交互
 * 这一层是唯一跟"网页"绑定的部分。将来搬去小程序，重写这一层即可。
 * ========================================================================= */

(function () {
  'use strict';

  var E = window.YT.engine;
  var S = window.YT.stats;
  var store = window.YT.store;
  var MODULES = window.YT.MODULES;
  var CFG = window.YT.CONFIG;

  var state = store.load();
  var app = document.getElementById('app');
  var overlay = document.getElementById('overlay');
  var draft = null;

  /* ---------------------------------------------------------------------
   * 小工具
   * ------------------------------------------------------------------- */

  function $(sel) { return document.querySelector(sel); }

  function todayKey() { return E.toKey(new Date()); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(key, withYear) {
    var d = E.parseKey(key);
    return (withYear ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function weekdayName(key) {
    return '周' + window.YT.WEEKDAY_NAMES[E.parseKey(key).getDay()];
  }

  function fmtMinutes(m) {
    m = Math.round(m);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' 小时 ' + r + ' 分' : h + ' 小时';
  }

  function pct(x) { return Math.round(x * 100) + '%'; }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }

  /* 页面内确认框。不用原生 confirm —— 手机上难看，以后搬去小程序也没有这个函数。 */
  var confirmCb = null;
  function askConfirm(title, message, cb) {
    confirmCb = cb;
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="modal-title">' + esc(title) + '</div>' +
        '<div class="modal-msg">' + esc(message) + '</div>' +
        '<div class="row" style="gap:10px;margin-top:18px">' +
          '<button class="btn grow" data-act="confirm-no">取消</button>' +
          '<button class="btn primary grow" data-act="confirm-yes">确定</button>' +
        '</div>' +
      '</div>';
  }

  function closeModal() {
    confirmCb = null;
    overlay.className = 'overlay hidden';
    overlay.innerHTML = '';
  }

  function save() { store.save(state); }

  function reRender() { render(); }

  function go(screen) {
    state.ui.screen = screen;
    moodPreview = null;
    save();
    window.scrollTo(0, 0);
    render();
  }

  /* ---------------------------------------------------------------------
   * 感受 → 计划微调的预览
   * ------------------------------------------------------------------- */

  var moodPreview = null;

  /* 明天起第一个"还没动过"的学习日。已打过卡的日子不会因为改感受被重排，
   * 所以预览也只看这一天。 */
  function nextFreshDay(tk) {
    var profile = state.profile;
    var d = E.addDays(E.parseKey(tk), 1);
    var guard = 0;
    while (guard < 40) {
      guard++;
      var k = E.toKey(d);
      if (profile.examDate && k > profile.examDate) return null;
      if (!E.isRest(d, profile)) {
        var day = state.days[k];
        if (!day) return k;
        var touched = day.mood || (day.tasks || []).some(function (t) {
          return t.status !== 'todo';
        });
        if (!touched) return k;
      }
      d = E.addDays(d, 1);
    }
    return null;
  }

  function normTitle(t) {
    return String(t || '').replace(/（\d+\/\d+）\s*$/, '');
  }

  /* 把一天的任务按"模块 + 类型"汇总成几行，用于前后对比 */
  function daySummary(k) {
    var day = state.days[k];
    if (!day) return null;
    var rows = {}, total = 0;
    (day.tasks || []).forEach(function (t) {
      var name = normTitle(t.title);
      var g = rows[name] || (rows[name] = { name: name, minutes: 0, qty: 0 });
      g.minutes += t.minutes;
      if (t.amount) g.qty += t.amount;
      total += t.minutes;
    });
    return { dateKey: k, total: total, rows: rows };
  }

  /* 只重排"还没动过"的未来天数，已打卡的一律保留 */
  function regenFuture(tk) {
    Object.keys(state.days).forEach(function (k) {
      if (k <= tk) return;
      var day = state.days[k];
      var touched = day.mood || (day.tasks || []).some(function (t) {
        return t.status !== 'todo';
      });
      if (!touched) delete state.days[k];
    });
    E.ensureAhead(state, tk, 14);
  }

  function buildMoodPreview(before, after, mf) {
    if (!before || !after) return null;
    var rows = [];
    Object.keys(before.rows).forEach(function (name) {
      var b = before.rows[name];
      var a = after.rows[name] || { minutes: 0, qty: 0 };
      if (b.minutes === a.minutes && b.qty === a.qty) return;
      rows.push({
        name: name,
        beforeText: (b.qty ? b.qty + ' 题 · ' : '') + b.minutes + ' 分',
        afterText: (a.qty ? a.qty + ' 题 · ' : '') + a.minutes + ' 分',
        up: a.minutes > b.minutes,
      });
    });
    return {
      dateKey: before.dateKey,
      totalBefore: before.total,
      totalAfter: after.total,
      factor: mf.factor,
      samples: mf.samples,
      rows: rows,
    };
  }

  /* ---------------------------------------------------------------------
   * 计划生成 / 滚动
   * ------------------------------------------------------------------- */

  function generateAll(onDone) {
    var tk = todayKey();
    var profile = state.profile;

    state.roadmap = E.buildRoadmap(profile, tk);

    /* 清掉旧的安排重新排：今天之前的一律保留（那是历史），
     * 今天及以后只保留"用户已经动过"的天，其余全部重排。
     * 只删今天之后是不够的——那样改了参数以后，今天的任务还是旧的那份。 */
    Object.keys(state.days).forEach(function (k) {
      if (k < tk) return;
      var day = state.days[k];
      var touched = day.mood || (day.tasks || []).some(function (t) {
        return t.status !== 'todo';
      });
      if (!touched) delete state.days[k];
    });

    /* 本次重排不再套用上周的调整系数，否则连着点两次会越排越少 */
    state.weekMark = state.weekMark || {};
    state.weekMark[E.weekKeyOf(tk)] = true;

    E.ensureAhead(state, tk, 14);
    save();

    if (onDone) onDone();
  }

  function generateWithOverlay(onDone) {
    var msgs = [
      '正在读取你的可用时间和考试日期…',
      '正在确定各模块的先后顺序…',
      '正在推算每天的题量和时长…',
      '正在排未来两周的每日任务…',
    ];
    var i = 0;
    overlay.className = 'overlay';
    overlay.innerHTML = '<div class="spin"></div><div class="msg">' + msgs[0] + '</div>';

    var timer = setInterval(function () {
      i++;
      if (i < msgs.length) {
        overlay.querySelector('.msg').textContent = msgs[i];
      }
    }, 950);

    setTimeout(function () {
      clearInterval(timer);
      generateAll(function () {
        overlay.className = 'overlay hidden';
        overlay.innerHTML = '';
        if (onDone) onDone();
      });
      save();
      render();
    }, 950 * msgs.length);
  }

  /* 每次打开时把过期没做完的任务顺延 / 砍掉，并保证未来两周已排好 */
  function dailyRoll() {
    var tk = todayKey();

    /* 1. 如果跨进了新的一周，先按上周的实际表现重排本周还没开始的部分 */
    var roll = E.rollWeek(state, tk);

    /* 2. 把过去没做完的顺延下去，超量的直接砍掉 */
    var d = E.addDays(E.parseKey(tk), -1);
    var guard = 0;
    while (guard < 7) {
      guard++;
      var k = E.toKey(d);
      var day = state.days[k];
      if (day && !day.isRest && !day.rolled && (day.tasks || []).length) {
        E.carryOver(state, k, 5);
        day.rolled = true;
      }
      d = E.addDays(d, -1);
    }

    /* 3. 保证未来两周都是排好的 */
    E.ensureAhead(state, tk, 14);

    /* 4. 记一笔，让用户看得到"为什么这周变少了" */
    if (roll.ws && roll.ws.planned > 0) {
      state.weeklyLog = (state.weeklyLog || []).filter(function (x) {
        return x.weekKey !== roll.weekKey;
      });
      state.weeklyLog.push({
        weekKey: roll.weekKey,
        rate: roll.ws.rate,
        label: roll.rule ? roll.rule.label : '',
        factor: roll.factor,
      });
      if (state.weeklyLog.length > 12) state.weeklyLog = state.weeklyLog.slice(-12);
    }
  }

  /* ---------------------------------------------------------------------
   * 问卷
   * ------------------------------------------------------------------- */

  function freshDraft() {
    var d = {
      examDate: '',
      base: 'zero',
      weekdayMinutes: 90,
      weekendMinutes: 180,
      restDays: [0],
      lessonMinutes: 150,
      speed: 1.5,
      courseUnits: {},
      benchmarks: {},
    };
    MODULES.forEach(function (m) { d.courseUnits[m.id] = m.courseUnits; });
    return d;
  }

  var ONBOARD_STEPS = 6;

  function renderOnboarding() {
    if (!draft) draft = freshDraft();
    var step = state.ui.onboardStep || 0;
    var bars = '';
    for (var i = 0; i < ONBOARD_STEPS; i++) bars += '<i class="' + (i <= step ? 'on' : '') + '"></i>';

    var body = '';
    var canNext = true;

    if (step === 0) {
      body =
        '<h2>你打算什么时候考？</h2>' +
        '<p class="lead">这是整个计划的锚点，后面所有安排都从这一天倒推。</p>' +
        '<div class="field"><label>考试日期</label>' +
        '<input class="input" type="date" id="f-exam" value="' + esc(draft.examDate) + '"></div>' +
        '<div class="chips">' +
        '<button class="chip" data-act="exam-preset" data-months="2">约 2 个月后</button>' +
        '<button class="chip" data-act="exam-preset" data-months="4">约 4 个月后</button>' +
        '<button class="chip" data-act="exam-preset" data-months="6">约 6 个月后</button>' +
        '</div>' +
        '<div class="footnote">国考一般在 11 月底，多数省考在次年 3 月中。不确定就填个大概，以后随时能改。</div>';
      canNext = !!draft.examDate;

    } else if (step === 1) {
      body = '<h2>你现在的基础？</h2><p class="lead">这决定基础期占多久——课听过一轮的人，不需要再花同样时间。</p>';
      window.YT.BASE_OPTIONS.forEach(function (o) {
        body += '<button class="opt ' + (draft.base === o.id ? 'on' : '') + '" data-act="pick-base" data-v="' + o.id + '">' +
                '<div class="t">' + esc(o.label) + '</div><div class="d">' + esc(o.desc) + '</div></button>';
      });

    } else if (step === 2) {
      body = '<h2>工作日每天能学多久？</h2><p class="lead">按真实的来，不要按理想状态填。</p>';
      window.YT.TIME_OPTIONS.forEach(function (o) {
        body += '<button class="opt ' + (draft.weekdayMinutes === o.minutes ? 'on' : '') + '" data-act="pick-wd" data-v="' + o.minutes + '">' +
                '<div class="t">' + esc(o.label) + '</div></button>';
      });

    } else if (step === 3) {
      body = '<h2>周末每天能学多久？</h2><p class="lead">工作日和周末分开算，计划才不会天天排不下。</p>';
      window.YT.TIME_OPTIONS.forEach(function (o) {
        body += '<button class="opt ' + (draft.weekendMinutes === o.minutes ? 'on' : '') + '" data-act="pick-we" data-v="' + o.minutes + '">' +
                '<div class="t">' + esc(o.label) + '</div></button>';
      });

    } else if (step === 4) {
      body = '<h2>每周想休息哪几天？</h2><p class="lead">休息日不排任务，也不影响连续打卡。留出喘息的空间，才走得远。</p>';
      body += '<div class="daypicker">';
      for (var i2 = 0; i2 < 7; i2++) {
        var on = draft.restDays.indexOf(i2) !== -1;
        body += '<button class="' + (on ? 'on' : '') + '" data-act="toggle-rest" data-v="' + i2 + '">' +
                window.YT.WEEKDAY_NAMES[i2] + '</button>';
      }
      body += '</div><div class="footnote">建议至少留 1 天。休息日不算漏打卡，连续天数不会断。</div>';

    } else if (step === 5) {
      body = '<h2>你手上的课有多少节？</h2>' +
             '<p class="lead">按模块填，不知道就先留默认值，以后随时能改。</p>' +
             '<div class="numlist">';
      MODULES.forEach(function (m) {
        var v = draft.courseUnits[m.id];
        body += '<div class="item"><label>' + esc(m.name) + '</label>' +
                '<input type="number" min="0" step="1" data-act="set-units" data-m="' + m.id + '" value="' + (v === undefined ? '' : v) + '">' +
                '<span class="unit">节</span></div>';
      });
      body += '</div>';
      body += '<div class="numlist" style="margin-top:10px">' +
              '<div class="item"><label>每节课时长</label>' +
              '<input type="number" min="20" step="5" data-act="set-lesson" value="' + draft.lessonMinutes + '"><span class="unit">分钟</span></div>' +
              '<div class="item"><label>听课倍速</label>' +
              '<input type="number" min="1" max="3" step="0.1" data-act="set-speed" value="' + draft.speed + '"><span class="unit">倍</span></div>' +
              '</div>';
      body += '<div class="footnote">每节课 2.5 小时、1.5 倍速听，实际约 100 分钟。这个数直接决定基础期要排多少天。</div>';
    }

    var prev = step > 0 ? '<button class="btn" data-act="ob-prev">上一步</button>' : '<span></span>';
    var nextLabel = step === ONBOARD_STEPS - 1 ? '生成我的备考计划' : '下一步';
    var nextDisabled = canNext ? '' : ' style="opacity:.4;pointer-events:none"';

    app.innerHTML =
      '<div class="onboard">' +
        '<div class="steps">' + bars + '</div>' +
        body +
      '</div>' +
      '<div class="sticky-cta">' +
        '<div class="row" style="gap:10px">' + prev +
        '<button class="btn primary grow" data-act="ob-next"' + nextDisabled + '>' + nextLabel + '</button></div>' +
      '</div>';
  }

  function finishOnboarding() {
    var profile = {
      examDate: draft.examDate,
      base: draft.base,
      weekdayMinutes: draft.weekdayMinutes,
      weekendMinutes: draft.weekendMinutes,
      restDays: draft.restDays.slice().sort(),
      lessonMinutes: Number(draft.lessonMinutes) || 150,
      speed: Number(draft.speed) || 1.5,
      courseUnits: draft.courseUnits,
      benchmarks: draft.benchmarks || {},
      strength: {},
      createdAt: new Date().toISOString(),
    };
    MODULES.forEach(function (m) { profile.strength[m.id] = 'normal'; });

    state.profile = profile;
    state.days = {};
    state.roadmap = null;

    generateWithOverlay(function () {
      state.ui.screen = 'today';
      save();
      render();
      toast('计划已生成');
    });
  }

  /* ---------------------------------------------------------------------
   * 今日
   * ------------------------------------------------------------------- */

  function actualOptions(minutes) {
    var mults = [0.6, 0.8, 1, 1.25, 1.5];
    var out = [];
    mults.forEach(function (x) {
      var v = Math.max(5, Math.round(minutes * x / 5) * 5);
      if (out.indexOf(v) === -1) out.push(v);
    });
    return out;
  }

  function renderTask(t, dateKey) {
    var cls = t.status === 'done' ? 'done' : t.status === 'half' ? 'half' : '';
    var rowCls = t.status === 'done' ? ' is-done' : '';
    var html = '<div class="task' + rowCls + '">' +
      '<button class="tick ' + cls + '" data-act="cycle" data-date="' + dateKey + '" data-task="' + esc(t.id) + '" aria-label="标记完成"></button>' +
      '<div class="task-body">' +
        '<div class="task-title">' + esc(t.title) + '</div>' +
        (t.detail ? '<div class="task-detail">' + esc(t.detail) + '</div>' : '') +
        '<div class="task-meta">' +
          '<span>' + esc(t.amountText || '') + '</span>' +
          '<span>约 ' + fmtMinutes(t.minutes) + '</span>' +
          (t.carried ? '<span class="pill warn">顺延</span>' : '') +
          (t.status === 'half' ? '<span class="pill">完成一半</span>' : '') +
        '</div>';

    var canTime = (t.kind === 'practice' || t.kind === 'essay' || t.kind === 'paperset');
    if (t.status === 'done' && canTime) {
      if (t.actualMinutes) {
        html += '<div class="task-meta"><span class="pill plain">实际 ' + fmtMinutes(t.actualMinutes) + '</span></div>';
      } else {
        html += '<div class="actual"><div class="hint">实际用了多久？点一下就行，不点也没关系</div><div class="chips">';
        actualOptions(t.minutes).forEach(function (v) {
          html += '<button class="chip" data-act="set-actual" data-date="' + dateKey + '" data-task="' + esc(t.id) + '" data-min="' + v + '">' + v + ' 分</button>';
        });
        html += '<button class="chip" data-act="skip-actual" data-date="' + dateKey + '" data-task="' + esc(t.id) + '">跳过</button>';
        html += '</div></div>';
      }
    }

    html += '</div></div>';
    return html;
  }

  function renderToday() {
    var tk = todayKey();
    if (!state.days[tk]) { E.ensureAhead(state, tk, 14); save(); }
    var day = state.days[tk];
    var profile = state.profile;

    if (!day) {
      app.innerHTML = '<div class="screen"><div class="top"><h1>计划已结束</h1>' +
        '<div class="sub">考试日已经过去了。去设置里改一下考试日期，我重新给你排。</div></div></div>';
      return renderTabbar('today');
    }

    var st = S.streak(state, tk);
    var head = '<div class="today-head">' +
      '<div class="date">' + fmtDate(tk, true) + ' · ' + weekdayName(tk) + '</div>' +
      '<h1>' + (day.isRest ? '今天休息' : stageLabel(day.stage)) + '</h1>' +
      (st > 0 ? '<div class="date" style="margin-top:6px">连续 ' + st + ' 天</div>' : '') +
      '</div>';

    if (day.isRest) {
      app.innerHTML = '<div class="screen">' + head +
        '<div class="rest-hero"><div class="big">☕</div>' +
        '<h2>今天不排任务</h2>' +
        '<p>好好休息，明天接着走。<br>休息日不算漏打卡，连续天数不会断。</p></div>' +
        '<div class="section"><button class="btn block" data-act="unrest">今天想学一会儿</button></div>' +
        '</div>';
      return renderTabbar('today');
    }

    var s = E.dayStats(day);
    var tasksHtml = (day.tasks || []).map(function (t) { return renderTask(t, tk); }).join('');
    if (!tasksHtml) tasksHtml = '<div class="task"><div class="task-body muted tiny">今天没有安排任务。</div></div>';

    var allDone = (day.tasks || []).length > 0 && (day.tasks || []).every(function (t) { return t.status === 'done'; });

    app.innerHTML = '<div class="screen">' + head +
      '<div class="section">' +
        '<div class="card">' +
          '<div class="row between" style="margin-bottom:2px">' +
            '<span class="tiny muted">今日进度</span>' +
            '<span class="tiny muted">' + pct(s.rate) + '</span>' +
          '</div>' +
          '<div class="daybar"><i style="width:' + Math.round(s.rate * 100) + '%"></i></div>' +
          '<div class="daybar-meta"><span>计划 ' + fmtMinutes(s.planned) + '</span>' +
          '<span>已完成 ' + fmtMinutes(s.done) + '</span></div>' +
        '</div>' +
      '</div>' +

      (allDone ? '<div class="section"><div class="card" style="background:var(--primary-s);box-shadow:none">' +
        '<div style="font-weight:600;color:var(--primary)">今天全部完成 ✓</div>' +
        '<div class="tiny muted" style="margin-top:3px">这就是节奏感。明天见。</div></div></div>' : '') +

      '<div class="section"><p class="section-title">今日任务</p><div class="card">' + tasksHtml + '</div></div>' +

      '<div class="section"><p class="section-title">今天感觉怎么样</p>' +
        '<div class="moods">' +
          moodBtn('easy', '太轻松', day.mood) +
          moodBtn('ok', '刚好', day.mood) +
          moodBtn('tired', '有点累', day.mood) +
          moodBtn('hard', '太难了', day.mood) +
        '</div>' +
        moodPreviewHtml() +
        '<div class="footnote">选完立刻生效：还没开始的那些天会按最近几次的感受重排，已经打过卡的日子不动。</div>' +
      '</div>' +
      '</div>';
    renderTabbar('today');
    save();
  }

  function moodPreviewHtml() {
    if (!moodPreview) return '';
    var m = moodPreview;
    var pct = Math.round((m.factor - 1) * 100);
    var head = pct > 0 ? '接下来刷题和复盘加量 ' + pct + '%'
             : pct < 0 ? '接下来刷题和复盘减量 ' + (-pct) + '%'
             : '任务量保持不变';

    var rowsHtml = m.rows.length
      ? m.rows.map(function (r) {
          return '<div class="mp-row">' +
            '<span class="mp-name">' + esc(r.name) + '</span>' +
            '<span class="mp-val"><s>' + esc(r.beforeText) + '</s><i>→</i>' +
            '<b class="' + (r.up ? 'up' : 'down') + '">' + esc(r.afterText) + '</b></span>' +
          '</div>';
        }).join('')
      : '<div class="mp-row"><span class="mp-name muted">各项任务的量都没有变化</span></div>';

    return '<div class="mood-preview">' +
      '<div class="mp-head' + (pct > 0 ? ' up' : '') + '">' + head + '</div>' +
      '<div class="mp-sub">' + fmtDate(m.dateKey, false) + ' ' + weekdayName(m.dateKey) +
        '　' + fmtMinutes(m.totalBefore) + ' → ' + fmtMinutes(m.totalAfter) + '</div>' +
      '<div class="mp-rows">' + rowsHtml + '</div>' +
      '<div class="mp-note">按最近 ' + m.samples + ' 天的感受算出来的，之后每天打卡都会重新评估。</div>' +
    '</div>';
  }

  function moodBtn(id, label, cur) {
    return '<button class="mood ' + (cur === id ? 'on' : '') + '" data-act="mood" data-v="' + id + '">' + label + '</button>';
  }

  function stageLabel(key) {
    var map = { base: '基础期', strengthen: '强化期', sprint: '冲刺期' };
    return map[key] || '备考中';
  }

  /* ---------------------------------------------------------------------
   * 计划
   * ------------------------------------------------------------------- */

  function renderPlan() {
    var tk = todayKey();
    var profile = state.profile;
    var rm = state.roadmap;
    if (!rm) { E.ensureAhead(state, tk, 14); rm = state.roadmap; }

    var todayStage = E.stageOf(tk, rm);

    var stagesHtml = rm.stages.map(function (st, i) {
      var cur = st.key === todayStage ? ' cur' : '';
      var range = st.startKey ? (fmtDate(st.startKey, false) + ' – ' + fmtDate(st.endKey, false)) : '—';
      return '<div class="stage' + cur + '">' +
        '<div class="stage-idx">' + (i + 1) + '</div>' +
        '<div class="grow"><div class="stage-name">' + st.name + (st.key === todayStage ? ' · 进行中' : '') + '</div>' +
        '<div class="stage-date">' + range + ' · ' + st.studyDays + ' 个学习日</div>' +
        '<div class="tiny muted" style="margin-top:3px">' + esc(st.goal) + '</div></div></div>';
    }).join('');

    /* 听课体检 */
    var lc = rm.lessonCheck;
    var checkHtml = '';
    if (lc && !lc.fit) {
      checkHtml = '<div class="section"><div class="card" style="background:var(--accent-s);box-shadow:none">' +
        '<div style="font-weight:600;color:var(--accent)">课时量偏大</div>' +
        '<div class="tiny" style="margin-top:4px;color:var(--ink-2)">' +
        '按现在的节数和倍速，听课需要 <b>' + lc.needDays + ' 个学习日</b>，但基础期只有 <b>' + lc.baseDays + ' 天</b>。' +
        '会挤压后面的强化和冲刺。可以：提高倍速、减少要听的节数（比如数量关系只挑重点听），或者把每日时长调高。</div>' +
        '<button class="btn sm ghost" style="margin-top:10px" data-act="goto" data-to="settings">去调整</button>' +
        '</div></div>';
    } else if (lc) {
      checkHtml = '<div class="section"><div class="card" style="background:var(--primary-s);box-shadow:none">' +
        '<div class="tiny" style="color:var(--primary)">课时量排得下：听课约需 ' + lc.needDays + ' 个学习日，基础期有 ' + lc.baseDays + ' 天。</div>' +
        '</div></div>';
    }

    /* 上周表现 → 这周怎么调 */
    var wlog = state.weeklyLog || [];
    var lastLog = wlog.length ? wlog[wlog.length - 1] : null;
    var logHtml = '';
    if (lastLog) {
      logHtml = '<div class="section"><div class="card" style="background:#f2efe9;box-shadow:none">' +
        '<div class="tiny" style="color:var(--ink-2)">上周（' + fmtDate(lastLog.weekKey, false) + '那一周）完成 <b>' +
        pct(lastLog.rate) + '</b> —— ' + esc(lastLog.label) + '</div>' +
        '</div></div>';
    }

    /* ---- 计划视图：本周 / 两周 / 本月 ---- */
    var rangeMode = state.ui.planRange || 'week';
    var rng = planRangeFor(tk, rangeMode);
    var needStudy = E.countStudyDays(rng.startKey,
      E.toKey(E.addDays(E.parseKey(rng.endKey), 1)), profile);
    E.ensureAhead(state, tk, Math.max(14, needStudy + 1));

    var rangeBar = '<div class="segmented">' +
      segBtn('week',  '本周', rangeMode) +
      segBtn('two',   '两周', rangeMode) +
      segBtn('month', '本月', rangeMode) +
    '</div>' +
    '<div class="range-note">' + fmtDate(rng.startKey, false) + ' – ' + fmtDate(rng.endKey, false) + '</div>';

    var curD = E.parseKey(rng.startKey);
    var endD = E.parseKey(rng.endKey);
    var dguard = 0;
    var dayKeys = [];
    while (curD <= endD && dguard < 62) {
      dguard++;
      dayKeys.push(E.toKey(curD));
      curD = E.addDays(curD, 1);
    }

    /* 三种粒度用三种展示：一周展开看细节，两周折叠便于扫，
     * 一个月用日历——一个月的量本来就是"一屏"的事，列表硬凑不合适。 */
    var daysHtml;
    if (rangeMode === 'month') {
      daysHtml = calendarHtml(dayKeys, tk, profile);
    } else if (rangeMode === 'two') {
      daysHtml = dayKeys.map(function (k) {
        return renderPlanDay(k, tk, profile, true);
      }).join('');
    } else {
      daysHtml = dayKeys.map(function (k) {
        return renderPlanDay(k, tk, profile, false);
      }).join('');
    }

    /* 听课进度 */
    var prog = E.courseProgress(state);
    var progRows = MODULES.map(function (m) {
      var need = E.targetUnits(m, profile);
      if (need <= 0) return '';
      var done = Math.min(need, prog[m.id] || 0);
      return '<div class="prog">' +
        '<div class="prog-name">' + esc(m.short) + '</div>' +
        '<div class="prog-bar"><i style="width:' + Math.round(done / need * 100) + '%"></i></div>' +
        '<div class="prog-val">' + done + ' / ' + need + ' 节</div>' +
      '</div>';
    }).join('');

    app.innerHTML = '<div class="screen">' +
      '<div class="top"><h1>我的计划</h1>' +
      '<div class="sub">距离 ' + fmtDate(profile.examDate, true) + ' 还有 ' + rm.totalStudyDays + ' 个学习日</div></div>' +

      '<div class="section"><p class="section-title">总体节奏</p><div class="card">' + stagesHtml + '</div></div>' +
      checkHtml +
      logHtml +

      '<div class="section"><p class="section-title">日程</p>' + rangeBar +
        '<div class="card" style="margin-top:10px">' + daysHtml + '</div></div>' +
      '<div class="section"><p class="section-title">听课进度</p><div class="card">' + progRows + '</div></div>' +
      '</div>';
    renderTabbar('plan');
  }

  function planRangeFor(tk, mode) {
    var t = E.parseKey(tk);
    var start, end;
    if (mode === 'week') {
      var wd = t.getDay();
      var back = wd === 0 ? 6 : wd - 1;         // 回到周一
      start = E.addDays(t, -back);               // 本周一
      end = E.addDays(start, 6);                 // 本周日
    } else if (mode === 'two') {
      start = t;
      end = E.addDays(t, 13);
    } else {
      start = t;
      end = new Date(t.getFullYear(), t.getMonth() + 1, 0);  // 本月最后一天
    }
    return { startKey: E.toKey(start), endKey: E.toKey(end) };
  }

  function segBtn(v, label, cur) {
    return '<button class="' + (v === cur ? 'on' : '') + '" data-act="plan-range" data-v="' + v + '">' + label + '</button>';
  }

  var STAGE_NAME = { base: '基础期', strengthen: '强化期', sprint: '冲刺期' };

  function dayLoad(k, tk, profile) {
    var day = state.days[k];
    var d = E.parseKey(k);
    var isRest = day ? day.isRest : E.isRest(d, profile);
    var total = day ? day.tasks.reduce(function (s, t) { return s + t.minutes; }, 0) : 0;
    return { day: day, date: d, isRest: isRest, total: total };
  }

  function renderPlanDay(k, tk, profile, collapsible) {
    var info = dayLoad(k, tk, profile);
    var day = info.day, d = info.date, isRest = info.isRest, total = info.total;
    var label = k === tk ? '今天' : weekdayName(k);
    var head = '<div class="pd-head">' +
      '<div class="pd-date">' + label + '<small>' + (d.getMonth() + 1) + '/' + d.getDate() + '</small></div>' +
      '<div class="pd-total">' + (isRest ? '休息' : (total ? fmtMinutes(total) : '—')) + '</div>' +
    '</div>';

    if (isRest) return '<div class="plan-day rest' + (collapsible ? ' foldable' : '') + '">' + head + '</div>';
    if (!day) {
      return k < tk
        ? '<div class="plan-day past">' + head + '</div>'
        : '<div class="plan-day">' + head + '<div class="pd-stage">还没排到</div></div>';
    }

    var stageName = STAGE_NAME[day.stage] || '';

    if (collapsible) {
      var open = !!(state.ui.expandedDays && state.ui.expandedDays[k]);
      var kinds = [];
      (day.tasks || []).forEach(function (t) {
        var n = t.moduleName;
        if (kinds.indexOf(n) === -1) kinds.push(n);
      });
      var body = open
        ? '<div class="pd-stage">' + stageName + '</div><div class="pd-tasks">' + taskRows(day) + '</div>'
        : '';
      return '<div class="plan-day foldable' + (open ? ' open' : '') + '" data-act="fold-day" data-v="' + k + '">' +
        head +
        (open ? '' : '<div class="pd-brief">' + esc(kinds.join(' · ')) + '</div>') +
        body + '</div>';
    }

    return '<div class="plan-day">' + head +
      '<div class="pd-stage">' + stageName + '</div>' +
      '<div class="pd-tasks">' + taskRows(day) + '</div></div>';
  }

  function taskRows(day) {
    return (day.tasks || []).map(function (t) {
      var mark = t.status === 'done' ? '<i class="pd-mark done">✓</i>'
               : t.status === 'half' ? '<i class="pd-mark half">◐</i>' : '';
      return '<div class="pd-task">' +
        '<span class="pd-t">' + mark + esc(t.title) + '</span>' +
        '<span class="pd-d">' + esc(t.detail || t.amountText || '') + '</span>' +
        '<span class="pd-min">' + t.minutes + ' 分</span>' +
      '</div>';
    }).join('');
  }

  /* 月历：一屏看完一个月，哪几天重、哪几天休息、哪几天打没打卡一目了然 */
  function calendarHtml(dayKeys, tk, profile) {
    if (!dayKeys.length) return '';
    var first = E.parseKey(dayKeys[0]);
    var last = E.parseKey(dayKeys[dayKeys.length - 1]);
    var back = first.getDay() === 0 ? 6 : first.getDay() - 1;
    var gridStart = E.addDays(first, -back);
    var fwd = last.getDay() === 0 ? 0 : 7 - last.getDay();
    var gridEnd = E.addDays(last, fwd);

    var maxTotal = 1;
    dayKeys.forEach(function (k) {
      var i = dayLoad(k, tk, profile);
      if (i.total > maxTotal) maxTotal = i.total;
    });

    var heads = ['一', '二', '三', '四', '五', '六', '日']
      .map(function (w) { return '<div class="cal-head">' + w + '</div>'; }).join('');

    var cells = '';
    var d = gridStart;
    var guard = 0;
    while (d <= gridEnd && guard < 45) {
      guard++;
      var k = E.toKey(d);
      var inRange = dayKeys.indexOf(k) !== -1;
      var info = inRange ? dayLoad(k, tk, profile) : null;

      if (!inRange) {
        cells += '<div class="cal-cell out"></div>';
      } else {
        var cls = 'cal-cell';
        if (info.isRest) cls += ' rest';
        if (k === tk) cls += ' today';
        if (state.ui.calDay === k) cls += ' sel';
        var ratio = info.isRest ? 0 : Math.max(6, Math.round(info.total / maxTotal * 100));
        var mins = info.isRest ? '休' : (info.total ? Math.round(info.total / 60 * 10) / 10 + 'h' : '');
        cells += '<button class="' + cls + '" data-act="cal-pick" data-v="' + k + '">' +
          '<span class="cal-d">' + d.getDate() + '</span>' +
          '<span class="cal-bar"><i style="height:' + ratio + '%"></i></span>' +
          '<span class="cal-mini">' + mins + '</span>' +
        '</button>';
      }
      d = E.addDays(d, 1);
    }

    var sel = state.ui.calDay;
    if (!sel || dayKeys.indexOf(sel) === -1) sel = tk;
    var detail = renderPlanDay(sel, tk, profile, false);

    return '<div class="cal-grid">' + heads + cells + '</div>' +
      '<div class="cal-detail">' + detail + '</div>';
  }


  /* ---------------------------------------------------------------------
   * 统计
   * ------------------------------------------------------------------- */

  function renderStats() {
    var tk = todayKey();
    var o = S.overall(state, tk);
    var st = S.streak(state, tk);
    var timing = S.moduleTiming(state);

    var rows = timing.map(function (r) {
      var med = r.medianPerQuestion === null ? '—' : (Math.round(r.medianPerQuestion * 10) / 10) + ' 分';
      var sug = r.suggestion === null ? '<span class="muted">数据不足</span>'
        : (r.suggestion !== r.current
            ? '<button class="chip" data-act="apply-bench" data-m="' + r.moduleId + '" data-v="' + r.suggestion + '">用 ' + r.suggestion + ' 分</button>'
            : '<span class="muted">已是最新</span>');
      return '<tr>' +
        '<td>' + esc(r.short) + '</td>' +
        '<td class="num">' + r.samples + '</td>' +
        '<td class="num">' + med + '</td>' +
        '<td class="num right">' + r.current + ' 分</td>' +
        '<td class="right">' + sug + '</td>' +
      '</tr>';
    }).join('');

    var anySamples = timing.some(function (r) { return r.samples > 0; });

    app.innerHTML = '<div class="screen">' +
      '<div class="top"><h1>统计</h1><div class="sub">这些数字用来把计划调得越来越贴合你</div></div>' +

      '<div class="section"><div class="metrics">' +
        '<div class="metric"><div class="v">' + st + '</div><div class="k">连续打卡</div></div>' +
        '<div class="metric"><div class="v">' + o.daysStudied + '</div><div class="k">学习天数</div></div>' +
        '<div class="metric"><div class="v">' + (o.planned ? pct(o.rate) : '—') + '</div><div class="k">完成任务</div></div>' +
      '</div></div>' +

      '<div class="section">' +
        '<p class="section-title">做题速度</p>' +
        '<div class="card">' +
          (anySamples
            ? '<table class="table"><thead><tr>' +
              '<th>模块</th><th>记录</th><th>每题中位</th><th class="right">当前基准</th><th class="right">建议</th>' +
              '</tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="tiny muted">还没有记录。<br><br>打卡时如果顺手填一下实际用时，攒够 5 次我就能算出你自己做题的真实速度，然后用它来重排后面的任务量。别人拍脑袋定的计划，你可以用数据定。</div>'
          ) +
        '</div>' +
        (anySamples ? '<div class="footnote">用中位数，避免某一次特殊情况把结果带偏。每项攒满 5 次记录才会给建议值。</div>' : '') +
      '</div>' +

      '<div class="section">' +
        '<p class="section-title">累计</p>' +
        '<div class="card">' +
          '<div class="row between" style="padding:5px 0"><span class="muted tiny">计划总时长</span><b>' + fmtMinutes(o.planned) + '</b></div>' +
          '<div class="row between" style="padding:5px 0"><span class="muted tiny">已完成</span><b>' + fmtMinutes(o.done) + '</b></div>' +
          '<div class="row between" style="padding:5px 0"><span class="muted tiny">你记录的实际用时</span><b>' + (o.actual ? fmtMinutes(o.actual) : '—') + '</b></div>' +
        '</div>' +
      '</div>' +
      '</div>';
    renderTabbar('stats');
  }

  /* ---------------------------------------------------------------------
   * 设置
   * ------------------------------------------------------------------- */

  function renderSettings() {
    var p = state.profile;

    var restPicker = '<div class="daypicker">';
    for (var i = 0; i < 7; i++) {
      var on = p.restDays.indexOf(i) !== -1;
      restPicker += '<button class="' + (on ? 'on' : '') + '" data-act="set-rest" data-v="' + i + '">' + window.YT.WEEKDAY_NAMES[i] + '</button>';
    }
    restPicker += '</div>';

    var strengthRows = MODULES.map(function (m) {
      var cur = p.strength[m.id] || 'normal';
      var btns = ['strong', 'normal', 'light', 'skip'].map(function (k) {
        return '<button class="chip ' + (cur === k ? 'on' : '') + '" data-act="set-strength" data-m="' + m.id + '" data-v="' + k + '">' +
               window.YT.STRENGTH[k].label + '</button>';
      }).join('');
      return '<div style="padding:9px 0;border-bottom:1px solid var(--line)">' +
        '<div class="row between" style="margin-bottom:6px"><span style="font-size:13.5px">' + esc(m.short) + '</span>' +
        '<span class="tiny muted">' + (E.targetUnits(m, p)) + ' 节</span></div>' +
        '<div class="chips">' + btns + '</div></div>';
    }).join('');

    app.innerHTML = '<div class="screen">' +
      '<div class="top"><h1>设置</h1><div class="sub">改完以后，点最下面那个按钮重排后面的计划</div></div>' +

      '<div class="section"><p class="section-title">考试与时间</p><div class="card">' +
        '<div class="field"><label>考试日期</label>' +
        '<input class="input" type="date" data-act="set-exam" value="' + esc(p.examDate) + '"></div>' +
        '<div class="field"><label>工作日每天可用</label>' +
        '<select class="input" data-act="set-wd">' +
          window.YT.TIME_OPTIONS.map(function (o) {
            return '<option value="' + o.minutes + '"' + (p.weekdayMinutes === o.minutes ? ' selected' : '') + '>' + o.label + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field"><label>周末每天可用</label>' +
        '<select class="input" data-act="set-we">' +
          window.YT.TIME_OPTIONS.map(function (o) {
            return '<option value="' + o.minutes + '"' + (p.weekendMinutes === o.minutes ? ' selected' : '') + '>' + o.label + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field" style="margin-bottom:6px"><label>每周休息日</label>' + restPicker + '</div>' +
      '</div></div>' +

      '<div class="section"><p class="section-title">听课</p><div class="card">' +
        '<div class="numlist">' +
          '<div class="item"><label>每节课时长</label><input type="number" min="20" step="5" data-act="set-lesson" value="' + p.lessonMinutes + '"><span class="unit">分钟</span></div>' +
          '<div class="item"><label>听课倍速</label><input type="number" min="1" max="3" step="0.1" data-act="set-speed" value="' + p.speed + '"><span class="unit">倍</span></div>' +
        '</div>' +
      '</div></div>' +

      '<div class="section"><p class="section-title">各模块课节数</p><div class="card">' +
        '<div class="numlist">' +
          MODULES.map(function (m) {
            var v = (p.courseUnits && p.courseUnits[m.id] !== undefined && p.courseUnits[m.id] !== '')
              ? p.courseUnits[m.id] : m.courseUnits;
            return '<div class="item"><label>' + esc(m.short) + '</label>' +
              '<input type="number" min="0" step="1" data-act="set-units" data-m="' + m.id + '" value="' + v + '">' +
              '<span class="unit">节</span></div>';
          }).join('') +
        '</div>' +
        '<div class="footnote">填你手上那套课的实际节数，不知道大概多少就先留默认值。改完点最下面重排，基础期长度会跟着变。</div>' +
      '</div></div>' +

      '<div class="section"><p class="section-title">各模块强度</p>' +
        '<div class="card" style="padding-top:4px;padding-bottom:4px">' + strengthRows + '</div>' +
        '<div class="footnote">"减少"适合你本身有底子的模块，"不学"适合你打算放弃的（比如数量关系）。这比逐条改任务省事，改完系统自己重排。</div>' +
      '</div>' +

      '<div class="section"><p class="section-title">高级参数</p><div class="card">' +
        '<button class="param-toggle" data-act="toggle-advanced">' +
          (state.ui.showAdvanced ? '收起 ▲' : '展开 ▼') +
          '<span>默认值就是推荐值，一般不用动</span>' +
        '</button>' +
        (state.ui.showAdvanced ? advancedRows() : '') +
      '</div></div>' +

      '<div class="section"><p class="section-title">数据</p><div class="card">' +
        '<button class="btn block" data-act="export">导出数据（备份用）</button>' +
        '<div style="height:8px"></div>' +
        '<button class="btn block" data-act="import">导入数据</button>' +
        '<div style="height:8px"></div>' +
        '<button class="btn block danger" data-act="wipe">清空全部数据</button>' +
      '</div></div>' +

      '<div class="sticky-cta above-tabs"><button class="btn primary block" data-act="regen">重新生成后面的计划</button></div>' +
      '</div>';
    renderTabbar('settings');
  }

  /* 高级参数：只影响"排多少"，不影响"排什么"，所以随便调也不会把计划调坏 */
  function advancedRows() {
    var t = (state.profile && state.profile.tuning) || {};
    function val(k) {
      return (t[k] === undefined || t[k] === null || t[k] === '') ? CFG[k] : t[k];
    }
    function row(k, label, scale, unit, rec, note) {
      var shown = Math.round(val(k) * scale * 100) / 100;
      return '<div class="param-row">' +
        '<div class="param-head"><span class="param-label">' + esc(label) + '</span>' +
        '<span class="param-rec">推荐 ' + rec + (unit || '') + '</span></div>' +
        '<div class="param-input">' +
          '<input type="number" data-act="set-param" data-k="' + k + '" data-scale="' + scale + '" value="' + shown + '">' +
          (unit ? '<span class="unit">' + unit + '</span>' : '') +
        '</div>' +
        (note ? '<div class="param-note">' + esc(note) + '</div>' : '') +
      '</div>';
    }
    return row('essayShare', '申论占比', 100, '%', '35',
               '申论单独占每天多少时间。剩下的是行测。') +
           row('reviewRatio', '复盘系数', 1, '', '1.4',
               '复盘一道错题比做一道题多花多少倍时间。') +
           row('maxReviewMinutes', '复盘时长上限', 1, '分钟', '60',
               '当天复盘再长也不会超过这个数。') +
           row('moodWeight', '感受调整幅度', 100, '%', '8',
               '选一次"太轻松"或"太难了"，任务量变动多少。') +
           row('maxPracticePerModule', '单科每日上限', 1, '分钟', '120',
               '同一科超过这个时长就拆成"第 1 组 / 第 2 组"。') +
           row('maxLessonUnitsPerDay', '单日听课上限', 1, '节', '3', '一天最多听几节课。') +
           '<button class="btn ghost block" style="margin-top:12px" data-act="reset-tuning">全部恢复推荐值</button>';
  }

  /* ---------------------------------------------------------------------
   * 底部导航
   * ------------------------------------------------------------------- */

  function renderTabbar(active) {
    var tabs = [
      { id: 'today', label: '今日' },
      { id: 'plan', label: '计划' },
      { id: 'stats', label: '统计' },
      { id: 'settings', label: '设置' },
    ];
    var html = '<div class="tabbar">' + tabs.map(function (t) {
      return '<button class="tab ' + (t.id === active ? 'on' : '') + '" data-act="goto" data-to="' + t.id + '">' +
             '<span class="dot"></span>' + t.label + '</button>';
    }).join('') + '</div>';
    app.insertAdjacentHTML('beforeend', html);
  }

  /* ---------------------------------------------------------------------
   * 主渲染
   * ------------------------------------------------------------------- */

  function render() {
    if (!state.profile) { renderOnboarding(); return; }
    var s = state.ui.screen || 'today';
    if (s === 'today') return renderToday();
    if (s === 'plan') return renderPlan();
    if (s === 'stats') return renderStats();
    if (s === 'settings') return renderSettings();
    return renderToday();
  }

  /* ---------------------------------------------------------------------
   * 事件
   * ------------------------------------------------------------------- */

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var tk = todayKey();

    /* ---- 问卷 ---- */
    if (act === 'exam-preset') {
      var months = Number(el.getAttribute('data-months'));
      var d = new Date();
      d.setMonth(d.getMonth() + months);
      draft.examDate = E.toKey(d);
      return reRender();
    }
    if (act === 'pick-base') { draft.base = el.getAttribute('data-v'); return reRender(); }
    if (act === 'pick-wd') { draft.weekdayMinutes = Number(el.getAttribute('data-v')); return reRender(); }
    if (act === 'pick-we') { draft.weekendMinutes = Number(el.getAttribute('data-v')); return reRender(); }
    if (act === 'toggle-rest') {
      var v = Number(el.getAttribute('data-v'));
      var i = draft.restDays.indexOf(v);
      if (i === -1) draft.restDays.push(v); else draft.restDays.splice(i, 1);
      return reRender();
    }
    if (act === 'ob-prev') { state.ui.onboardStep = Math.max(0, (state.ui.onboardStep || 0) - 1); save(); return reRender(); }
    if (act === 'ob-next') {
      var step = state.ui.onboardStep || 0;
      if (step === 0 && !draft.examDate) return toast('先选个考试日期');
      if (step === ONBOARD_STEPS - 1) return finishOnboarding();
      state.ui.onboardStep = step + 1;
      save();
      window.scrollTo(0, 0);
      return reRender();
    }

    /* ---- 导航 ---- */
    if (act === 'goto') return go(el.getAttribute('data-to'));

    /* ---- 打卡 ---- */
    if (act === 'cycle') {
      var dk = el.getAttribute('data-date');
      var tid = el.getAttribute('data-task');
      var day = state.days[dk];
      if (!day) return;
      var task = (day.tasks || []).filter(function (t) { return t.id === tid; })[0];
      if (!task) return;
      task.status = task.status === 'todo' ? 'done' : task.status === 'done' ? 'half' : 'todo';
      if (task.status !== 'done') task.actualMinutes = null;
      save();
      return reRender();
    }
    if (act === 'set-actual') {
      var dk2 = el.getAttribute('data-date'), tid2 = el.getAttribute('data-task');
      var t2 = ((state.days[dk2] || {}).tasks || []).filter(function (t) { return t.id === tid2; })[0];
      if (!t2) return;
      t2.actualMinutes = Number(el.getAttribute('data-min'));
      save();
      return reRender();
    }
    if (act === 'skip-actual') {
      var dk3 = el.getAttribute('data-date'), tid3 = el.getAttribute('data-task');
      var t3 = ((state.days[dk3] || {}).tasks || []).filter(function (t) { return t.id === tid3; })[0];
      if (!t3) return;
      t3.actualMinutes = -1; /* -1 表示"这次不记"，不再弹出 */
      save();
      return reRender();
    }
    if (act === 'mood') {
      var dayM = state.days[tk];
      if (!dayM) return;
      var mv = el.getAttribute('data-v');
      var nextMood = dayM.mood === mv ? null : mv;

      /* 先把"改之前"的样子记下来，改完再对比 */
      var previewKey = nextMood ? nextFreshDay(tk) : null;
      var before = previewKey ? daySummary(previewKey) : null;

      dayM.mood = nextMood;
      regenFuture(tk);

      if (before) {
        moodPreview = buildMoodPreview(before, daySummary(previewKey), E.moodFactor(state, tk));
      } else {
        moodPreview = null;
      }
      save();
      return reRender();
    }
    if (act === 'unrest') {
      var dd = state.days[tk];
      dd.isRest = false;
      dd.tasks = E.buildTasks(E.parseKey(tk), tk, state, state.roadmap, null);
      save();
      return reRender();
    }

    /* ---- 统计 ---- */
    if (act === 'apply-bench') {
      var mid = el.getAttribute('data-m');
      var val = Number(el.getAttribute('data-v'));
      state.profile.benchmarks = state.profile.benchmarks || {};
      state.profile.benchmarks[mid] = val;
      save();
      toast('已把' + mid + '的基准改成 ' + val + ' 分钟/题，下次重排生效');
      return reRender();
    }

    /* ---- 计划视图切换 ---- */
    if (act === 'plan-range') {
      state.ui.planRange = el.getAttribute('data-v');
      save();
      return reRender();
    }
    if (act === 'fold-day') {
      var fk = el.getAttribute('data-v');
      state.ui.expandedDays = state.ui.expandedDays || {};
      if (state.ui.expandedDays[fk]) delete state.ui.expandedDays[fk];
      else state.ui.expandedDays[fk] = true;
      save();
      return reRender();
    }
    if (act === 'cal-pick') {
      state.ui.calDay = el.getAttribute('data-v');
      save();
      return reRender();
    }

    /* ---- 高级参数 ---- */
    if (act === 'toggle-advanced') {
      state.ui.showAdvanced = !state.ui.showAdvanced;
      save();
      return reRender();
    }
    if (act === 'reset-tuning') {
      state.profile.tuning = {};
      save();
      toast('已恢复推荐值');
      return reRender();
    }

    /* ---- 设置 ---- */
    if (act === 'set-rest') {
      var rv = Number(el.getAttribute('data-v'));
      var idx = state.profile.restDays.indexOf(rv);
      if (idx === -1) state.profile.restDays.push(rv);
      else state.profile.restDays.splice(idx, 1);
      state.profile.restDays.sort();
      save();
      return reRender();
    }
    if (act === 'set-strength') {
      state.profile.strength[el.getAttribute('data-m')] = el.getAttribute('data-v');
      save();
      return reRender();
    }
    if (act === 'regen') {
      generateWithOverlay(function () {
        toast('已按新设置重排');
        go('today');
      });
      return;
    }
    if (act === 'export') {
      var blob = new Blob([store.exportJSON(state)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '备考节奏-备份-' + tk + '.json';
      a.click();
      return toast('已导出');
    }
    if (act === 'import') {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            state = store.importJSON(String(fr.result));
            save();
            toast('导入成功');
            render();
          } catch (e) { toast('导入失败：文件格式不对'); }
        };
        fr.readAsText(f);
      };
      inp.click();
      return;
    }
    if (act === 'wipe') {
      return askConfirm('清空全部数据', '所有计划、打卡记录和统计都会删掉，没有办法恢复。确定吗？', function () {
        state = store.reset();
        draft = null;
        save();
        render();
      });
    }

    /* ---- 弹窗 ---- */
    if (act === 'confirm-yes') {
      var cb = confirmCb;
      closeModal();
      if (cb) cb();
      return;
    }
    if (act === 'confirm-no') return closeModal();
  });

  /* 输入类控件 */
  document.addEventListener('input', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');

    if (act === 'set-units') {
      var mid = el.getAttribute('data-m');
      var val = el.value === '' ? '' : Number(el.value);
      if (state.profile) { state.profile.courseUnits[mid] = val; save(); }
      else if (draft) { draft.courseUnits[mid] = val; }
      return;
    }
    if (act === 'set-param') {
      var pk = el.getAttribute('data-k');
      var scale = Number(el.getAttribute('data-scale') || 1);
      state.profile.tuning = state.profile.tuning || {};
      if (el.value === '') {
        delete state.profile.tuning[pk];
      } else {
        var pv = Number(el.value) / scale;
        if (!isNaN(pv)) state.profile.tuning[pk] = pv;
      }
      save();
      return;
    }
    if (act === 'set-lesson') {
      if (draft) draft.lessonMinutes = Number(el.value);
      else { state.profile.lessonMinutes = Number(el.value); save(); }
      return;
    }
    if (act === 'set-speed') {
      var v = Math.max(1, Math.min(3, Number(el.value) || 1));
      if (draft) draft.speed = v;
      else { state.profile.speed = v; save(); }
      return;
    }
    if (act === 'set-exam') { state.profile.examDate = el.value; save(); return; }
    if (act === 'set-wd') { state.profile.weekdayMinutes = Number(el.value); save(); return; }
    if (act === 'set-we') { state.profile.weekendMinutes = Number(el.value); save(); return; }
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    if (el.getAttribute('data-act') === 'set-exam') { state.profile.examDate = el.value; save(); }
  });

  /* ---------------------------------------------------------------------
   * 启动
   * ------------------------------------------------------------------- */

  function boot() {
    if (state.profile) {
      dailyRoll();
      save();
    }
    render();
  }

  /* 调试用：在浏览器控制台里输入 __ytDebug() 就能看到当前状态 */
  window.__ytDebug = function () { return state; };

  boot();
})();
