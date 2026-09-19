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
  var MODULE_BY_ID = window.YT.MODULE_BY_ID;
  var CFG = window.YT.CONFIG;

  /* ?fresh=1：给朋友试用时用的一次性入口。
   * 清掉本地数据，回到问卷第一页；清完就把参数从网址里去掉，
   * 之后他们再打开同一个网址，进度不会被重复清空。 */
  var forceFresh = false;
  try {
    forceFresh = /(?:^|[?&])fresh=1(?:&|$)/.test(window.location.search);
    if (forceFresh) window.localStorage.removeItem(store.KEY);
  } catch (e) { forceFresh = false; }
  var state = store.load();
  if (forceFresh) {
    try {
      var params = new URLSearchParams(window.location.search);
      params.delete('fresh');
      var qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    } catch (e) {}
  }
  var app = document.getElementById('app');
  var overlay = document.getElementById('overlay');
  var draft = null;
  var lastEnterKey = '';
  var pendingRestart = null;   // 断更回来时，等这一屏画完再弹学习档案
  var deferredInstallPrompt = null;   // Chrome / 安卓的"添加到桌面"事件

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(window.navigator.userAgent)
      || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  }

  function installHintVisible() {
    return !(state.ui && state.ui.installHintDismissed);
  }

  /* ---------------------------------------------------------------------
   * 小工具
   * ------------------------------------------------------------------- */

  function $(sel) { return document.querySelector(sel); }

  /* 正常情况下就是真实今天。开发者工具里"快进"时会被换成模拟日期，
   * 这样所有已经写好的逻辑（周重排、顺延、阶段推进）走的是真实代码路径。 */
  function todayKey() { return state.simDate || E.toKey(new Date()); }

  function realTodayKey() { return E.toKey(new Date()); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 任务 id 必须唯一：查任务、打卡、删除全靠它对上号。
   * 只用 Date.now() 的话，同一毫秒里加两条就会撞 id——
   * 表现就是"点第二条没反应"（其实是改到了第一条）。 */
  var uidSeq = 0;
  function uid(prefix) {
    uidSeq++;
    return prefix + Date.now() + '-' + uidSeq;
  }

  function fmtDate(key, withYear) {
    if (!key) return '—';
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

  /* 一次性说明弹窗，只有一个"知道了"。
   * 用来回答"我改完之后到底变了什么"——以前只有一句 toast，说不清楚。 */
  function showNote(title, lines) {
    confirmCb = null;
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="modal-title">' + esc(title) + '</div>' +
        '<div class="modal-msg">' + lines.map(function (l) { return esc(l); }).join('<br>') + '</div>' +
        '<div class="row" style="gap:10px;margin-top:18px">' +
          '<button class="btn primary grow" data-act="confirm-no">知道了</button>' +
        '</div>' +
      '</div>';
  }

  /* 带输入框的弹窗，用来补记已听的课 */
  var inputCb = null;
  function askInput(title, message, value, onOk) {
    inputCb = onOk;
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="modal-title">' + esc(title) + '</div>' +
        '<div class="modal-msg">' + esc(message) + '</div>' +
        '<input class="input" type="number" min="0" step="0.5" id="ask-input" value="' + value + '" style="margin-top:14px">' +
        '<div class="row" style="gap:10px;margin-top:16px">' +
          '<button class="btn grow" data-act="ask-no">取消</button>' +
          '<button class="btn primary grow" data-act="ask-yes">确定</button>' +
        '</div>' +
      '</div>';
    setTimeout(function () {
      var el = document.getElementById('ask-input');
      if (el) { el.focus(); el.select(); }
    }, 50);
  }

  function closeAsk() {
    inputCb = null;
    overlay.className = 'overlay hidden';
    overlay.innerHTML = '';
  }

  /* ---------------------------------------------------------------------
   * B2 记录一次成绩
   * 只填手上有的模块，其他留空。攒下来之后复盘时长、模块强度建议
   * 都会用真实数据算，不再拍脑袋。
   * ------------------------------------------------------------------- */

  var scoreDraft = null;

  /* 打开表单（初始化一次）和重画表单（保留已填内容）要分开。
   * 之前点来源按钮会重新初始化，把刚选的和刚填的全冲掉了——
   * 所以"模块刷题""真题套卷"看着像点不动。 */
  function openScoreForm() {
    var last = (state.scores || [])[(state.scores || []).length - 1];
    scoreDraft = {
      date: todayKey(),
      source: (last && last.source) || '模考',
      rates: {},
    };
    renderScoreForm();
  }

  function renderScoreForm() {
    if (!scoreDraft) return;
    var rows = MODULES.filter(function (m) { return !m.essay; }).map(function (m) {
      var tgt = window.YT.moduleParam(m, state.profile, 'targetRate');
      var cur = scoreDraft.rates[m.id];
      var v = (cur === undefined || cur === null || cur === '') ? '' : Math.round(cur * 100);
      return '<div class="score-row">' +
        '<span class="sr-name">' + esc(m.short) + '</span>' +
        '<input type="number" min="0" max="100" step="1" data-act="score-rate" data-m="' + m.id + '" value="' + v + '" placeholder="—">' +
        '<span class="sr-pct">%</span>' +
        (tgt !== null && tgt !== undefined ? '<span class="sr-tgt">目标 ' + Math.round(tgt * 100) + '</span>' : '<span class="sr-tgt">未设目标</span>') +
      '</div>';
    }).join('');

    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal" style="max-width:420px">' +
        '<div class="modal-title">记录一次成绩</div>' +
        '<div class="modal-msg">只填有数据的，其他留空。</div>' +
        '<div class="score-form">' +
          '<div class="score-row">' +
            '<span class="sr-name">日期</span>' +
            '<input type="date" data-act="score-date" value="' + scoreDraft.date + '" style="flex:1">' +
          '</div>' +
          '<div class="score-row">' +
            '<span class="sr-name">来源</span>' +
            '<div class="chips" style="margin:0">' +
              ['模考', '模块刷题', '真题套卷'].map(function (s) {
                return '<button class="chip ' + (scoreDraft.source === s ? 'on' : '') + '" data-act="score-source" data-v="' + s + '">' + s + '</button>';
              }).join('') +
            '</div>' +
          '</div>' +
          rows +
        '</div>' +
        '<div class="row" style="gap:10px;margin-top:16px">' +
          '<button class="btn grow" data-act="score-cancel">取消</button>' +
          '<button class="btn primary grow" data-act="score-save">保存</button>' +
        '</div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------------
   * 批量排：一次排好几周的固定安排
   *
   * 想"每天刷资料 2 组、连着排 4 周"的人，不该一天一天点 30 次。
   * 窗口就是提前排的窗口（今天起 30 天），排完告诉你哪几天超载。
   * ------------------------------------------------------------------- */

  var batchDraft = null;

  function openBatch() {
    batchDraft = {
      group: null,
      moduleId: null,
      weekdays: [1, 2, 3, 4, 5],
      units: 1,
      weeks: 4,
      essayBig: false,
    };
    renderBatch();
  }

  function renderBatch() {
    if (!batchDraft) return;
    var d = batchDraft;
    var groups = EXTRA_GROUPS.map(function (x) {
      return '<button class="chip ' + (d.group === x.id ? 'on' : '') + '" data-act="batch-group" data-v="' + x.id + '">' + x.name + '</button>';
    }).join('');

    var sub = '';
    if (d.group === 'pd') {
      sub = '<div class="chips" style="margin-top:8px">' +
        ['pdlj', 'pdtx', 'pddl'].map(function (id) {
          var m = MODULE_BY_ID[id];
          return '<button class="chip ' + (d.moduleId === id ? 'on' : '') + '" data-act="batch-module" data-v="' + id + '">' +
                 esc(m.short.replace('判推', '')) + '</button>';
        }).join('') + '</div>';
    }
    if (d.group === 'slw') {
      sub = '<div class="chips" style="margin-top:8px">' +
        '<button class="chip ' + (!d.essayBig ? 'on' : '') + '" data-act="batch-essay" data-v="small">小题</button>' +
        '<button class="chip ' + (d.essayBig ? 'on' : '') + '" data-act="batch-essay" data-v="big">大作文</button>' +
        '</div>';
    }

    var wdBtns = [1, 2, 3, 4, 5, 6, 0].map(function (w) {
      var on = d.weekdays.indexOf(w) !== -1;
      return '<button class="chip ' + (on ? 'on' : '') + '" data-act="batch-wd" data-v="' + w + '">' +
             window.YT.WEEKDAY_NAMES[w] + '</button>';
    }).join('');

    var endKey = E.toKey(E.addDays(E.parseKey(todayKey()), Math.min(d.weeks * 7, PLAN_WINDOW_DAYS) - 1));

    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal arch-modal" style="max-width:430px">' +
        '<div class="modal-title">批量排</div>' +
        '<div class="modal-msg">一次排好几周，省得每天点。</div>' +

        '<div class="arch-block"><div class="arch-h">科目</div>' +
          '<div class="chips">' + groups + '</div>' + sub + '</div>' +

        '<div class="arch-block"><div class="arch-h">每周哪几天</div>' +
          '<div class="chips">' + wdBtns + '</div></div>' +

        '<div class="arch-block"><div class="numlist">' +
          '<div class="item"><label>' + (d.group === 'slw' ? '每天几' + (d.essayBig ? '篇' : '道') : '每天几组') + '</label>' +
            '<input type="number" min="0.5" step="0.5" data-act="batch-num" data-k="units" value="' + d.units + '"></div>' +
          '<div class="item"><label>持续几周</label>' +
            '<input type="number" min="1" max="26" step="1" data-act="batch-num" data-k="weeks" value="' + d.weeks + '"></div>' +
        '</div>' +
        '<div class="footnote">会排到 ' + fmtDate(endKey, false) + '（提前排最多 ' + PLAN_WINDOW_DAYS + ' 天）。' +
        '休息日自动跳过。</div></div>' +

        '<div class="row" style="gap:10px;margin-top:16px">' +
          '<button class="btn grow" data-act="batch-cancel">取消</button>' +
          '<button class="btn primary grow" data-act="batch-ok">排进去</button>' +
        '</div>' +
      '</div>';
  }

  /* 执行批量排。返回 { made, over } —— over 是排完超载的天数。 */
  function applyBatch() {
    var d = batchDraft;
    if (!d || !d.group) return null;
    if (d.group === 'pd' && !d.moduleId) return null;

    var p = state.profile;
    var tk = todayKey();
    /* 先把窗口内的天都排出来，免得往还不存在的日子上加 */
    E.ensureAhead(state, tk, PLAN_WINDOW_DAYS);

    var modules = [];
    if (d.group === 'pd') modules = [MODULE_BY_ID[d.moduleId]];
    else if (d.group === 'slw') modules = [MODULE_BY_ID.slw];
    else modules = [MODULE_BY_ID[d.group]];
    var m = modules[0];
    if (!m) return null;

    var startD = E.parseKey(tk);
    var limit = Math.min(Math.max(1, Number(d.weeks) || 1) * 7, PLAN_WINDOW_DAYS);
    var made = 0;

    for (var i = 0; i < limit; i++) {
      var day = E.addDays(startD, i);
      var k = E.toKey(day);
      if (d.weekdays.indexOf(day.getDay()) === -1) continue;
      if (E.isRest(day, p)) continue;              // 休息日不排
      var rec = state.days[k];
      if (!rec) continue;

      var stage = rec.stage || 'base';
      var task;
      if (m.essay) {
        var big = !!d.essayBig;
        task = {
          moduleId: 'slw', moduleName: '申论', kind: 'essay',
          title: '申论 · ' + (big ? '大作文' : '小题') + '（自己排的）',
          detail: big ? '完整写一篇，写完自己对答案改' : '认真写完，对照参考答案改',
          amounts: 1, amountText: big ? '1 篇' : '1 道',
          minutes: big ? window.YT.ESSAY.bigMinutes : window.YT.ESSAY.smallMinutes,
        };
      } else {
        var per = window.YT.unitMinutesFor(m, stage, p);
        var setSize = window.YT.moduleParam(m, p, 'setSize') || 20;
        var sets = Math.max(0.5, Math.round((Number(d.units) || 1) * 2) / 2);
        var q = Math.round(sets * setSize);
        task = {
          moduleId: m.id, moduleName: m.name, kind: 'practice',
          title: m.short + ' · 刷题（自己排的）',
          detail: sets + ' 组 · ' + q + ' 题',
          amount: q, sets: sets, amountText: q + ' 题',
          minutes: Math.round(q * per),
        };
      }
      task.id = uid('batch-');
      task.status = 'todo';
      task.actualMinutes = null;
      task.userAdded = true;
      rec.tasks.push(task);
      made++;
    }

    /* 排完看一眼哪几天被塞爆了。只是提示，不拦——那天你可能就是想拼一把。 */
    var over = 0;
    for (var j = 0; j < limit; j++) {
      var kk = E.toKey(E.addDays(startD, j));
      var rec2 = state.days[kk];
      if (!rec2 || rec2.isRest) continue;
      var cap = E.budgetFor(E.parseKey(kk), p, rec2.stage).total;
      var total = (rec2.tasks || []).reduce(function (a, t) { return a + (t.skip ? 0 : t.minutes); }, 0);
      if (total > cap) over++;
    }
    return { made: made, over: over };
  }

  /* ---------------------------------------------------------------------
   * C2 三个动作：今天不做 / 多做点 / 换成别的科目
   *
   * 跟"设置里调强度"的分工不一样：
   *   设置里调强度 = 整个备考期的结论
   *   这里的三个动作 = 今天的决定，不改后面的计划
   * "今天不做"不进完成率，但会被记下来；连着几天对同一科这么干，
   * 系统才开口问一句"要不要干脆把它调成减少"。
   * ------------------------------------------------------------------- */

  var taskMenu = null;   // { dateKey, taskId } —— 正打开的那一项

  function findTask(dateKey, taskId) {
    var day = state.days[dateKey];
    if (!day) return null;
    return (day.tasks || []).filter(function (x) { return x.id === taskId; })[0] || null;
  }

  /* 使用模式。老数据里没有这个字段的，按半自动算。 */
  function usageMode() {
    return E.usageModeOf(state.profile);
  }

  /* 当前主题。老档案里没有 theme 字段，落到默认那一个。
   * 主题本身是靠 html[data-theme] 上的 CSS 变量切的（见 styles.css），
   * 这里只负责把属性写上去。 */
  function themeOf() {
    /* 每一步都当它可能不存在。
     * 之前这里直接读 window.YT.THEME_BY_ID[id]，一旦浏览器留着旧版的 config.js
     * （里面还没有主题表），这里就抛错——render() 在它后面，整页白屏。 */
    var themes = (window.YT && window.YT.THEMES) || [];
    if (!themes.length) return 'champagne';
    var id = (state.profile && state.profile.theme) || window.YT.DEFAULT_THEME;
    for (var i = 0; i < themes.length; i++) {
      if (themes[i].id === id) return id;
    }
    return themes[0].id;
  }

  /* 切主题不用重画整屏：只改根节点上的属性，CSS 变量立刻全变。
   * 这样切换是瞬时的，也不会把滚动位置弄丢。 */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', themeOf());
  }

  /* 自己排模式：系统不排复盘，但可以按他今天自己排的量算一个建议时长，
   * 设不设置由他自己决定。算法跟系统排复盘时用的是同一套。 */
  function manualReviewHint(day) {
    if (usageMode() !== 'manual' || !day) return null;
    if (day.reviewAsked === 'no') return null;
    if ((day.tasks || []).some(function (t) { return t.kind === 'review'; })) return null;
    var practiceMin = 0;
    (day.tasks || []).forEach(function (t) {
      if (t.kind === 'practice' || t.kind === 'essay') practiceMin += t.minutes;
    });
    if (practiceMin < 40) return null;   // 排得太少就别啰嗦了
    var suggest = Math.max(15, Math.min(CFG.maxReviewMinutes,
      Math.round(practiceMin * E.errorRateFor(state) * CFG.reviewRatio)));
    return { minutes: suggest, practiceMin: practiceMin };
  }

  function openTaskMenu(dateKey, taskId) {
    var t = findTask(dateKey, taskId);
    if (!t) return;
    taskMenu = { dateKey: dateKey, taskId: taskId };

    /* 有顺序的课不给"换"——换掉它，后面的节次编号全乱。
     * 套卷也不给换，那本来就是整套。 */
    var canSwap = (t.kind === 'practice' || t.kind === 'essay');
    var mode = usageMode();

    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal" style="max-width:400px">' +
        '<div class="modal-title">' + esc(t.title) + '</div>' +
        (taskDetail(t) ? '<div class="modal-msg">' + esc(taskDetail(t)) + '</div>' : '') +
        '<div class="menu-list">' +
          (mode === 'auto' ? '' : (t.skip
            ? '<button class="menu-item" data-act="task-unskip">取消跳过，今天还是做</button>'
            : '<button class="menu-item" data-act="task-skip">今天不做这一项<small>不算你没完成，也不往后顺延</small></button>')) +
          (canSwap && mode !== 'auto'
            ? '<button class="menu-item" data-act="task-swap">换成别的科目<small>只换今天，后面的安排会跟着偏一点</small></button>'
            : '') +
          '<button class="menu-item danger" data-act="del-task" data-date="' + dateKey + '" data-task="' + esc(t.id) + '">' +
            '删除这一项<small>' + (t.kind === 'course' ? '这节课会顺延到后面' : '不影响后面的安排') + '</small></button>' +
        '</div>' +
        '<button class="btn block ghost" style="margin-top:12px" data-act="menu-cancel">取消</button>' +
      '</div>';
  }

  /* 换成别的科目：今天这条换成目标模块的同类任务，时长尽量保持。 */
  function openSwap() {
    if (!taskMenu) return;
    var t = findTask(taskMenu.dateKey, taskMenu.taskId);
    if (!t) return;
    var chips = MODULES.filter(function (m) {
      if (m.id === t.moduleId) return false;
      if (t.kind === 'essay') return !!m.essay;   // 申论只能换申论
      return !m.essay;                             // 行测只能换行测
    }).map(function (m) {
      return '<button class="chip" data-act="swap-pick" data-m="' + m.id + '">' + esc(m.short) + '</button>';
    }).join('');

    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal" style="max-width:400px">' +
        '<div class="modal-title">换成哪一科？</div>' +
        '<div class="modal-msg">换的是今天这一条，时长不变，题量按新科目的单价折算。</div>' +
        '<div class="chips" style="margin-top:14px">' + chips + '</div>' +
        '<button class="btn block ghost" style="margin-top:16px" data-act="menu-cancel">取消</button>' +
      '</div>';
  }

  /* 真正换掉。返回换成的模块 id（失败返回 null）。 */
  function applySwap(newModuleId) {
    if (!taskMenu) return null;
    var day = state.days[taskMenu.dateKey];
    var t = findTask(taskMenu.dateKey, taskMenu.taskId);
    var m = MODULE_BY_ID[newModuleId];
    if (!day || !t || !m) return null;
    var from = t.moduleId;

    if (t.kind === 'essay') {
      var big = (t.amountText || '').indexOf('篇') >= 0;
      t.moduleId = 'slw';
      t.moduleName = '申论';
      t.title = '申论 · ' + (big ? '大作文' : '小题');
      t.detail = big ? '完整写一篇，写完自己对答案改' : '认真写完，对照参考答案改';
    } else {
      var stage = day.stage || 'base';
      var per = window.YT.unitMinutesFor(m, stage, state.profile);
      var setSize = window.YT.moduleParam(m, state.profile, 'setSize') || 20;
      var sets = Math.max(0.5, Math.round((t.minutes / (per * setSize)) * 2) / 2);
      var q = Math.round(sets * setSize);
      t.moduleId = m.id;
      t.moduleName = m.name;
      t.kind = 'practice';
      t.title = m.short + ' · 刷题';
      t.detail = sets + ' 组 · ' + q + ' 题';
      t.amount = q;
      t.sets = sets;
      t.amountText = q + ' 题';
      t.minutes = Math.round(q * per);
      delete t.actualMinutes;
    }
    t.swappedFrom = from;

    /* 换成别的科目，等于"我不做原来的、改做这个"——跳过状态自然取消 */
    if (t.skip) {
      t.skip = false;
      delete t.skipAt;
      state.skipLog = (state.skipLog || []).filter(function (x) {
        return !(x.date === taskMenu.dateKey && x.moduleId === from);
      });
    }

    /* 记一笔方向：连着几次都往同一科换，才值得动权重 */
    state.swapLog = state.swapLog || [];
    state.swapLog.push({ date: taskMenu.dateKey, from: from, to: t.moduleId });
    if (state.swapLog.length > 40) state.swapLog = state.swapLog.slice(-40);

    save();
    return t.moduleId;
  }

  /* ---------------------------------------------------------------------
   * C2b 今天主攻一科
   *
   * 跟"自己加一项"不一样：加一项是在系统排的基础上再做，
   * 主攻是让系统排的今天全部让位，时间全给这一科。
   * 已经打过卡的、自己加的一律不动——那是已经发生的事。
   * ------------------------------------------------------------------- */

  var focusDraft = null;

  function openFocus() {
    var tk = todayKey();
    var day = state.days[tk];
    if (!day || day.isRest) { toast('今天是休息日，先歇着'); return; }
    var used = 0, doneCount = 0;
    (day.tasks || []).forEach(function (t) {
      /* 口径要跟 applyFocus 一致：还没做的系统任务会让位，不占时间。
       * 否则一天排满是常态，主攻就永远说"时间不够"。 */
      if (t.userAdded || t.status !== 'todo' || t.skip) used += t.minutes;
      if (t.status !== 'todo') doneCount++;
    });
    var cap = E.budgetFor(E.parseKey(tk), state.profile, day.stage).total;
    focusDraft = { left: Math.max(0, Math.round(cap - used)), doneCount: doneCount };
    renderFocus();
  }

  function renderFocus() {
    if (!focusDraft) return;
    var d = focusDraft;
    var chips = MODULES.map(function (m) {
      return '<button class="chip" data-act="focus-pick" data-m="' + m.id + '">' + esc(m.short) + '</button>';
    }).join('');

    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal" style="max-width:420px">' +
        '<div class="modal-title">今天主攻这一科</div>' +
        '<div class="modal-msg">' +
          (d.left >= 25
            ? '剩下的 ' + fmtMinutes(d.left) + ' 全部给这一科。'
            : '今天剩下的时间不多了，主攻排不出来。') +
          (d.doneCount ? '已经打完卡的 ' + d.doneCount + ' 项不动。' : '') +
        '</div>' +
        (d.left >= 25
          ? '<div class="chips" style="margin-top:14px">' + chips + '</div>' +
            '<div class="footnote" style="margin-top:14px">主攻的日子不计入完成率——' +
            '那是你自己安排的强度，不是系统排的量合不合适。</div>'
          : '') +
        '<div class="row" style="margin-top:16px">' +
          '<button class="btn grow" data-act="focus-cancel">取消</button>' +
        '</div>' +
      '</div>';
  }

  /* 把今天剩下的时间全给这一科。返回加了几条。 */
  function applyFocus(moduleId) {
    var tk = todayKey();
    var day = state.days[tk];
    if (!day) return -1;
    var p = state.profile;
    var stage = day.stage || 'base';

    /* 还没做的系统任务让位；打过卡的、自己加的留着 */
    day.tasks = (day.tasks || []).filter(function (t) {
      return t.userAdded || t.status !== 'todo' || t.skip;
    });

    var used = 0;
    day.tasks.forEach(function (t) { used += t.minutes; });
    var cap = E.budgetFor(E.parseKey(tk), p, stage).total;
    var left = Math.round(cap - used);
    if (left < 25) return 0;

    var stamp = Date.now();
    var made = 0;
    function push(t) {
      t.id = 'focus-' + stamp + '-' + (made++);
      t.userAdded = true;
      t.focus = true;
      t.status = 'todo';
      t.actualMinutes = null;
      day.tasks.push(t);
    }

    /* 申论那条线不按"组"算，按小题/大作文来 */
    if (moduleId === 'slw') {
      var left2 = left, guard = 0;
      while (left2 >= YT.ESSAY.smallMinutes && guard < 6) {
        guard++;
        var big = (left2 >= YT.ESSAY.bigMinutes + 40) && (guard % 2 === 0);
        var mins = big ? YT.ESSAY.bigMinutes : YT.ESSAY.smallMinutes;
        if (mins > left2) break;
        push({
          moduleId: 'slw', moduleName: '申论', kind: 'essay',
          title: big ? '申论 · 大作文（主攻）' : '申论 · 小题（主攻）',
          detail: big ? '完整写一篇，写完自己对答案改' : '认真写完，对照参考答案改',
          amounts: 1, amountText: big ? '1 篇' : '1 道', minutes: mins,
        });
        left2 -= mins;
      }
      return made;
    }

    var m = MODULE_BY_ID[moduleId];
    var per = YT.unitMinutesFor(m, stage, p);
    var setSize = YT.moduleParam(m, p, 'setSize') || 20;

    /* 先留出复盘的时间：主攻完总得回头看错题。
     * 剩得太少就不留了，不然刷不到几道题，主攻就名存实亡。 */
    var errRate = E.errorRateFor(state);
    var reviewMin = Math.max(20, Math.min(CFG.maxReviewMinutes,
      Math.round(left * errRate * CFG.reviewRatio)));
    if (left - reviewMin < 30) reviewMin = 0;
    var leftP = left - reviewMin;

    var guard2 = 0;
    while (leftP >= 20 && guard2 < 6) {
      guard2++;
      var take = Math.min(leftP, CFG.maxPracticePerModule);
      var sets = Math.max(0.5, Math.floor(take / (per * setSize) * 2) / 2);
      var q = Math.round(sets * setSize);
      var mins = Math.round(q * per);
      if (mins < 15 || mins > take * 1.2) break;
      push({
        moduleId: m.id, moduleName: m.name, kind: 'practice',
        title: m.short + ' · 主攻刷题',
        detail: sets + ' 组 · ' + q + ' 题',
        amount: q, sets: sets, amountText: q + ' 题', minutes: mins,
      });
      leftP -= mins;
    }

    if (reviewMin > 0 && made) {
      push({
        moduleId: 'review', moduleName: '复盘', kind: 'review',
        title: '错题复盘', detail: '把今天做错的题重做一遍，记下错因',
        minutes: reviewMin, amountText: reviewMin + ' 分钟',
      });
    }
    return made;
  }

  /* ---------------------------------------------------------------------
   * C8 偏好层：连续自己加同一个模块 → 主动问要不要排进日常
   *
   * 只调"刷题权重"，不动听课节数——判推逻辑的课早就听完了，
   * 单纯想多刷它的题，不该因为这个多出四节不存在的课。
   * ------------------------------------------------------------------- */

  /* 该不该问一句。问过就记住，不再烦人。 */
  function prefSuggestion() {
    var tk = todayKey();
    var ask = state.ui.prefAsked || {};
    var boosts = (state.profile && state.profile.practiceBoost) || {};
    var cands = window.YT.archive.selfAddedByModule(state, tk, 5).filter(function (c) {
      return c.days >= 3;   // 五个学习日里有三天自己加了，才算真倾向
    });
    for (var i = 0; i < cands.length; i++) {
      var id = cands[i].moduleId;
      if (ask[id]) continue;
      if (boosts[id]) continue;
      if (state.profile.strength && state.profile.strength[id] === 'skip') continue;
      var m = MODULE_BY_ID[id];
      if (!m) continue;
      return { moduleId: id, days: cands[i].days, name: m.short };
    }
    return null;
  }

  /* 连着几天"今天不做"同一科 → 这才是该调强度的时候。
   * 设置里那个"减少"是结论，这里是把用户攒出来的信号递给他确认。 */
  function skipSuggestion() {
    var tk = todayKey();
    var log = state.skipLog || [];
    if (!log.length) return null;
    var ask = state.ui.prefAsked || {};

    /* 最近五个学习日里，每一科各有几天被跳过 */
    var byDay = {};        // moduleId -> { '2026-10-01': true }
    var d = E.parseKey(tk);
    var seen = 0, guard = 0;
    while (seen < 5 && guard < 24) {
      guard++;
      var k = E.toKey(d);
      d = E.addDays(d, -1);
      var day = state.days[k];
      if (!day || day.isRest) continue;
      seen++;
      log.forEach(function (x) {
        if (x.date !== k) return;
        byDay[x.moduleId] = byDay[x.moduleId] || {};
        byDay[x.moduleId][k] = true;
      });
    }

    var best = null;
    Object.keys(byDay).forEach(function (id) {
      var n = Object.keys(byDay[id]).length;
      if (n < 3) return;
      if (ask['skip:' + id]) return;
      var cur = (state.profile.strength && state.profile.strength[id]) || 'normal';
      if (cur === 'light' || cur === 'skip') return;   // 已经调过了
      var m = MODULE_BY_ID[id];
      if (!m) return;
      if (!best || n > best.days) best = { moduleId: id, days: n, name: m.short };
    });
    return best;
  }

  /* ---------------------------------------------------------------------
   * 换一场考试
   *
   * 考公很少有人只考一次，所以这一步要给两条路：
   *   接着这轮学    —— 只是把考试日期挪到新的，学过的不重来
   *   开启新一轮    —— 这轮封存进学习档案，新一轮从今天重新排
   * 不管哪条路，上一轮听过的课都不会让人重听。
   * ------------------------------------------------------------------- */

  var switchDraft = null;

  function openSwitchExam() {
    var p = state.profile;
    var next = new Date();
    next.setMonth(next.getMonth() + 4);
    switchDraft = {
      mode: null,
      examDate: p.examDate > todayKey() ? p.examDate : E.toKey(next),
      name: '',
      weekdayMinutes: p.weekdayMinutes,
      weekendMinutes: p.weekendMinutes,
    };
    renderSwitchExam();
  }

  function renderSwitchExam() {
    if (!switchDraft) return;
    var d = switchDraft;
    var rounds = (state.rounds || []).length;

    var optHtml = [
      { v: 'continue', t: '接着这轮学', s: '只把考试日期改到新的。打过卡的日子、课程进度、成绩记录都留着。连着考、时间紧就选这个。' },
      { v: 'new', t: '开启新一轮', s: '这一轮封存进学习档案，新一轮从今天重新排。上一轮听过的课不用重听。' },
    ].map(function (o) {
      return '<button class="arch-item' + (d.mode === o.v ? ' on' : '') + '" data-act="switch-mode" data-v="' + o.v + '">' +
        '<span class="box">' + (d.mode === o.v ? '✓' : '') + '</span>' +
        '<span class="at"><b>' + o.t + '</b><span class="ad">' + o.s + '</span></span></button>';
    }).join('');

    var form = '';
    if (d.mode) {
      form =
        '<div class="score-form" style="max-height:none">' +
          '<div class="score-row"><span class="sr-name">考试日期</span>' +
            '<input type="date" data-act="switch-date" value="' + esc(d.examDate) + '" style="width:auto;flex:1;text-align:left"></div>' +
          (d.mode === 'new'
            ? '<div class="score-row"><span class="sr-name">这轮叫</span>' +
                '<input type="text" data-act="switch-name" value="' + esc(d.name) + '" placeholder="第 ' + (rounds + 2) + ' 轮（可不填）" ' +
                'style="width:auto;flex:1;text-align:left;font-weight:400"></div>' +
              '<div class="score-row"><span class="sr-name">工作日</span>' +
                '<select class="input" data-act="switch-wd" style="width:auto;flex:1">' +
                  window.YT.TIME_OPTIONS.map(function (o) {
                    return '<option value="' + o.minutes + '"' + (d.weekdayMinutes === o.minutes ? ' selected' : '') + '>' + o.label + '</option>';
                  }).join('') + '</select></div>' +
              '<div class="score-row"><span class="sr-name">周末</span>' +
                '<select class="input" data-act="switch-we" style="width:auto;flex:1">' +
                  window.YT.TIME_OPTIONS.map(function (o) {
                    return '<option value="' + o.minutes + '"' + (d.weekendMinutes === o.minutes ? ' selected' : '') + '>' + o.label + '</option>';
                  }).join('') + '</select></div>'
            : '') +
        '</div>' +
        (d.mode === 'new'
          ? '<div class="arch-note">你会从今天开始一份新计划。上一轮听到哪，新课就从哪接着听；' +
            '上一轮的成绩记录也留着，系统继续按你的真实正确率算复盘时间。</div>'
          : '');
    }

    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal arch-modal" style="max-width:430px">' +
        '<div class="modal-title">换一场考试</div>' +
        '<div class="modal-msg">这场是 ' + fmtDate(state.profile.examDate, true) + '。接下来怎么安排？</div>' +
        optHtml + form +
        '<div class="row" style="gap:10px;margin-top:16px">' +
          '<button class="btn grow" data-act="switch-cancel">取消</button>' +
          '<button class="btn primary grow" data-act="switch-confirm">确定</button>' +
        '</div>' +
      '</div>';
  }

  /* 真正切换。keepStart=false 表示这是新一轮，一切从今天算起。 */
  function applySwitch() {
    var d = switchDraft;
    var tk = todayKey();
    var p = state.profile;

    if (!d.mode) { toast('先选一种安排方式'); return false; }
    if (!d.examDate || d.examDate <= tk) { toast('考试日期要在今天之后'); return false; }

    if (d.mode === 'new') {
      var A = window.YT.archive;
      var sum = A.roundSummary(state.days, p);
      var n = (state.rounds || []).length + 1;
      state.rounds = state.rounds || [];
      state.rounds.push({
        id: 'r' + n,
        index: n,
        name: d.name || ('第 ' + n + ' 轮'),
        examDate: p.examDate,
        startKey: sum.startKey,
        endKey: sum.endKey || p.examDate,
        summary: sum,
        /* 这一轮开始时，从更早那轮带过来的进度。回看这一轮时要用它，
         * 否则课程进度条会和当时的节次编号对不上。 */
        inherited: p.inheritedProgress || null,
        days: state.days,
        weeklyLog: state.weeklyLog || [],
        archivedAt: new Date().toISOString(),
      });
      if (state.rounds.length > 6) state.rounds = state.rounds.slice(-6);

      /* 听完的课带过去，别让人重听一遍 */
      var carried = {};
      Object.keys(sum.course || {}).forEach(function (id) {
        if (sum.course[id] > 0.001) carried[id] = Math.round(sum.course[id] * 10) / 10;
      });
      p.inheritedProgress = carried;

      state.days = {};
      state.weekMark = {};
      state.weeklyLog = [];
      state.roadmap = null;
    }

    p.examDate = d.examDate;
    p.weekdayMinutes = Number(d.weekdayMinutes);
    p.weekendMinutes = Number(d.weekendMinutes);
    /* 换了考试日期，旧的阶段边界就不适用了，回到系统推荐值。 */
    p.phasePlan = { custom: false };

    var start = (d.mode === 'new') ? tk : ((state.roadmap && state.roadmap.startKey) || tk);
    state.roadmap = E.buildRoadmap(p, start);
    /* 今天及以后还没动过的，按新考试日期重排 */
    Object.keys(state.days).forEach(function (k) {
      if (k < tk) return;
      var day = state.days[k];
      var touched = E.dayTouched(day);
      if (!touched) delete state.days[k];
    });
    state.weekMark = state.weekMark || {};
    state.weekMark[E.weekKeyOf(tk)] = true;
    E.ensureAhead(state, tk, 14);
    save();
    return true;
  }

  /* ---------------------------------------------------------------------
   * C1 学习档案
   *
   * 两个入口共用这一套：
   *   view    —— 统计页里点开，随时都能看
   *   restart —— 断更之后自动弹出来，先说"你完成了什么"，再说"从哪接上"
   * 文案只写"怎么办"，不写"系统怎么工作"。
   * ------------------------------------------------------------------- */

  var archDraft = null;
  var ARCH_FOLD_AT = 5;   // 超过这个条数才折叠——一天做 5 项对全职备考是正常的

  function barWidth(done, need) {
    if (!need) return 0;
    return Math.max(0, Math.min(100, Math.round(done / need * 100)));
  }

  function openArchive(mode, info, round) {
    var tk = todayKey();
    var stage = (state.days[tk] || {}).stage || 'base';
    var src = state, at = tk;
    if (round) {
      /* 看历史轮次：用那一轮开始时的进度口径，
       * 而不是现在这份（换过两轮之后数字会对不上）。 */
      var prof = {};
      Object.keys(state.profile || {}).forEach(function (k) { prof[k] = state.profile[k]; });
      prof.inheritedProgress = round.inherited || null;
      src = { profile: prof, days: round.days || {}, scores: [] };
      at = round.endKey || tk;
    }
    var arch = window.YT.archive.build(src, at, stage);
    archDraft = {
      mode: mode || 'view',
      info: info || null,
      round: round || null,
      arch: arch,
      showAll: false,
      items: (round ? [] : (arch.review || [])).map(function (r, i) {
        return { on: i < ARCH_FOLD_AT, item: r };   // 折叠起来的那几条默认不勾
      }),
    };
    renderArchive();
  }

  function renderArchive() {
    if (!archDraft) return;
    var a = archDraft.arch;
    var restart = archDraft.mode === 'restart';
    var past = archDraft.mode === 'round';

    /* ---- 听课 ---- */
    var courses = a.courses.slice().sort(function (x, y) {
      var rank = function (c) {
        if (c.done > 0.001 && c.done < c.need - 0.001) return 0;   // 听到一半的排最前
        if (c.done >= c.need - 0.001) return 1;                    // 听完的
        return 2;                                                  // 还没开始的
      };
      return rank(x) - rank(y) || 0;
    });
    /* 弹窗里按钮不能被挤到屏幕外，所以列表要克制 */
    var courseHidden = Math.max(0, courses.length - 5);
    courses = courses.slice(0, 5);

    var courseHtml = courses.map(function (c) {
      var done = c.done >= c.need - 0.001;
      return '<div class="arch-row">' +
        '<span class="an">' + esc(c.short) + '</span>' +
        '<span class="bar"><i style="width:' + barWidth(c.done, c.need) + '%"></i></span>' +
        '<span class="av">' + (Math.round(c.done * 10) / 10) + '/' + c.need + ' 节' +
          (done ? ' <em>✓</em>' : '') + '</span>' +
      '</div>';
    }).join('');

    /* ---- 刷题 ---- */
    var prac = a.practices.slice(0, 3);
    var pracHtml = prac.map(function (p) {
      return '<div class="arch-row"><span class="an">' + esc(p.short) + '</span>' +
        '<span class="bar"><i style="width:' + barWidth(p.questions, prac[0].questions) + '%"></i></span>' +
        '<span class="av">' + p.questions + ' 题</span></div>';
    }).join('');
    if (a.papers) {
      pracHtml += '<div class="arch-row"><span class="an">套卷</span><span class="bar"></span>' +
        '<span class="av">' + a.papers + ' 套</span></div>';
    }

    /* ---- 建议先回顾这些 ----
     * 5 条以内全摊开；超过 5 条，先给 5 条，剩下的折起来。
     * 折起来的默认不勾——不然点一下"就按这个来"等于一天干十件事。 */
    var headItems = archDraft.items.slice(0, ARCH_FOLD_AT);
    var tailItems = archDraft.items.slice(ARCH_FOLD_AT);

    function itemHtml(it, i) {
      return '<button class="arch-item' + (it.on ? ' on' : '') + '" data-act="arch-toggle" data-i="' + i + '">' +
        '<span class="box">' + (it.on ? '✓' : '') + '</span>' +
        '<span class="at"><b>' + esc(it.item.title) + '</b>' +
          '<span class="ad">' + esc(it.item.detail) + ' · ' + fmtMinutes(it.item.minutes) + '</span></span>' +
      '</button>';
    }

    var listHtml = headItems.map(itemHtml).join('');
    if (tailItems.length) {
      listHtml += archDraft.showAll
        ? tailItems.map(function (it, i) { return itemHtml(it, i + ARCH_FOLD_AT); }).join('') +
          '<button class="arch-fold" data-act="arch-more">收起 ▴</button>'
        : '<button class="arch-fold" data-act="arch-more">还有 ' + tailItems.length + ' 项，看看 ▾</button>';
    }
    var reviewHtml = listHtml;

    var head, sub;
    if (past) {
      var s = archDraft.round.summary || {};
      head = archDraft.round.name || '上一轮';
      sub = (archDraft.round.examDate ? fmtDate(archDraft.round.examDate, true) + '考完' : '') +
        (s.studiedDays ? ' · 学了 ' + s.studiedDays + ' 天' : '') +
        (s.questions ? ' · 累计 ' + s.questions + ' 题' : '') +
        (s.planned ? ' · 完成 ' + pct(s.rate) : '');
    } else if (restart) {
      head = '先看看你学到哪了';
      sub = (a.lastKey && archDraft.info)
        ? '你上次学习是 ' + fmtDate(a.lastKey, false) + '，中间隔了 ' + archDraft.info.missed + ' 个学习日。'
        : '';
    } else {
      head = '学习档案';
      sub = a.everStudied
        ? (a.gap === 0 ? '今天学过。' : '上次学习是 ' + a.gap + ' 天前。')
        : '还没有学习记录，从今天开始。';
    }

    var note = '';
    if (restart && archDraft.info) {
      note = '<div class="arch-note">中间那些天的旧计划已经清掉了，不用补。' +
        (archDraft.info.level === 'long'
          ? '今天先按六成的量来，接上比补上重要。'
          : '今天先按八成的量来，找回手感。') + '</div>';
    }

    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal arch-modal">' +
        '<div class="modal-title">' + esc(head) + '</div>' +
        (sub ? '<div class="modal-msg">' + esc(sub) + '</div>' : '') +
        note +

        '<div class="arch-block">' +
          '<div class="arch-h">听课</div>' + courseHtml +
          (courseHidden ? '<div class="arch-more">……还有 ' + courseHidden + ' 个模块</div>' : '') +
        '</div>' +

        '<div class="arch-block">' +
          '<div class="arch-h">刷题　<span class="arch-sum">累计 ' + a.questionTotal + ' 题</span></div>' +
          (pracHtml || '<div class="arch-more">还没练过题</div>') +
        '</div>' +

        (reviewHtml
          ? '<div class="arch-block">' +
              '<div class="arch-h">' +
                (tailItems.length && !archDraft.showAll ? '今天先做这些' : '建议先做这些') +
                '　<span class="arch-sum">不想做的点掉</span></div>' +
              reviewHtml +
            '</div>'
          : '') +

        '<div class="row" style="gap:10px;margin-top:18px">' +
          (restart ? '<button class="btn grow" data-act="arch-close">先不用</button>' : '') +
          (!restart && reviewHtml ? '<button class="btn grow" data-act="arch-close">知道了</button>' : '') +
          (past
            ? '<button class="btn primary grow" data-act="arch-close">知道了</button>'
            : reviewHtml
            ? '<button class="btn primary grow" data-act="arch-yes">' +
                (restart ? '就按这个来' : '加到今天') + '</button>'
            : '<button class="btn primary grow" data-act="arch-close">知道了</button>') +
        '</div>' +
      '</div>';
  }

  /* 把选中的回顾项加成今天的任务。
   * 加成"自己加的"：不进系统完成率，也不回头改后面的计划。 */
  function addReviewTasks() {
    var tk = todayKey();
    var picks = archDraft.items.filter(function (it) { return it.on; }).map(function (it) { return it.item; });
    if (!picks.length) return 0;

    if (!state.days[tk]) E.ensureAhead(state, tk, 1);
    var day = state.days[tk];
    if (!day || day.isRest) return -1;

    var added = 0;
    picks.forEach(function (r) {
      var dup = (day.tasks || []).some(function (t) { return t.review && t.moduleId === r.moduleId; });
      if (dup) return;
      /* 听课的回顾任务不能记成 kind='course'：
       * 那样会被当成"又听了一节新课"，既占了节次编号，又把听课进度加了一节。
       * 它只是把上一节回头看一遍，单独给一个 kind。 */
      var isCourseReview = r.kind === 'course';
      var t = {
        id: uid('review-'),
        moduleId: r.moduleId,
        moduleName: r.moduleName,
        kind: isCourseReview ? 'review' : 'practice',
        title: r.title,
        detail: r.detail,
        amountText: isCourseReview ? fmtMinutes(r.minutes) : r.amount + ' 题',
        minutes: r.minutes,
        status: 'todo',
        actualMinutes: null,
        userAdded: true,
        review: true,
      };
      if (isCourseReview) t.noSeq = true;
      else { t.amount = r.amount; t.sets = Math.round((r.amount / ((MODULE_BY_ID[r.moduleId] || {}).setSize || 20)) * 10) / 10; }
      day.tasks.push(t);
      added++;
    });
    return added;
  }

  /* 补记：把该模块未完成的课从前往后标记完成，不够的补一条记在今天。
   * 好处是不动数据结构——进度依然是算出来的，补记也是一条普通任务，删掉就能撤销。 */
  function markCourseDone(moduleId, wantTotal, tk) {
    var left = wantTotal;
    var keys = Object.keys(state.days).sort();
    for (var i = 0; i < keys.length && left > 0.001; i++) {
      var day = state.days[keys[i]];
      if (day.isRest) continue;
      var tasks = day.tasks || [];
      for (var j = 0; j < tasks.length && left > 0.001; j++) {
        var t = tasks[j];
        if (t.kind !== 'course' || t.moduleId !== moduleId || t.noSeq) continue;
        if (t.status === 'done') continue;
        var u = t.units || 1;
        if (u <= left) { t.status = 'done'; left -= u; }
      }
    }
    if (left > 0.001) {
      var m = MODULE_BY_ID[moduleId];
      var eff = E.effectiveLesson(state.profile);
      if (!state.days[tk]) { E.ensureAhead(state, tk, 1); }
      var today = state.days[tk];
      if (today) {
        today.isRest = false;
        today.tasks.push({
          id: uid('makeup-'),
          moduleId: moduleId, moduleName: m.name, kind: 'course',
          title: m.short + ' · 补记',
          detail: '已听 ' + left + ' 节',
          amounts: left, units: left,
          amountText: left + ' 节',
          minutes: Math.round(left * eff),
          status: 'done', actualMinutes: null,
          userAdded: true, noSeq: true,
        });
      }
    }
  }

  /* 反过来：把已听的课退回一部分。从后往前退，补记出来的那条直接删掉。 */
  function markCourseUndo(moduleId, removeUnits) {
    var left = removeUnits;
    var keys = Object.keys(state.days).sort().reverse();
    for (var i = 0; i < keys.length && left > 0.001; i++) {
      var day = state.days[keys[i]];
      var tasks = day.tasks || [];
      for (var j = tasks.length - 1; j >= 0 && left > 0.001; j--) {
        var t = tasks[j];
        if (t.kind !== 'course' || t.moduleId !== moduleId) continue;
        if (t.status === 'todo') continue;
        var u = t.units || 1;
        if (t.noSeq) {
          /* 补记出来的那条，直接删掉 */
          day.tasks.splice(j, 1);
          left -= u;
        } else if (t.status === 'done' && u <= left) {
          t.status = 'todo';
          t.actualMinutes = null;
          left -= u;
        } else if (t.status !== 'todo' && u > left) {
          /* 部分退回：把这条任务缩短，剩下的留到后面再退。
           * 不这么做的话，3 节往回退到 1 节会落在 1.5 节上——
           * 因为只能整条整条地退。 */
          var nu = Math.round((u - left) * 2) / 2;
          if (nu >= 0.5) {
            var perU = t.minutes / u;
            t.units = nu; t.amounts = nu;
            t.minutes = Math.round(nu * perU);
            t.amountText = nu + ' 节';
            t.status = 'todo';
            t.actualMinutes = null;
          } else {
            day.tasks.splice(j, 1);
          }
          left = 0;
        }
      }
    }
    return left;
  }

  /* ---------------------------------------------------------------------
   * 改动可视化
   * 任何结构性的改动（删任务、补记、重排）都会重排后面几天，
   * 但用户看不到"哪里变了"。所以每次改完都给一张对比清单 + 撤销。
   * ------------------------------------------------------------------- */

  var lastUndo = null;

  function takeSnapshot() {
    return {
      days: JSON.parse(JSON.stringify(state.days)),
      weeklyLog: JSON.parse(JSON.stringify(state.weeklyLog || [])),
      weekMark: JSON.parse(JSON.stringify(state.weekMark || {})),
      /* 顺手记一份课节数。撤销的时候连设置一起退回去，
       * 否则会出现"撤销了，但下次重排又按新节数来"这种怪事。 */
      courseUnits: JSON.parse(JSON.stringify((state.profile && state.profile.courseUnits) || {})),
      lessonMinutes: state.profile && state.profile.lessonMinutes,
      speed: state.profile && state.profile.speed,
    };
  }

  function dayLine(day) {
    if (!day) return '';
    if (day.isRest) return '休息';
    return (day.tasks || []).map(function (t) {
      var d = (t.kind === 'course' && !t.noSeq && courseLabels[t.id]) ? courseLabels[t.id]
            : (t.amountText || t.detail || '');
      return t.title + ' ' + d;
    }).join('　/　');
  }

  function diffDays(before, after) {
    var keys = {};
    Object.keys(before).forEach(function (k) { keys[k] = 1; });
    Object.keys(after).forEach(function (k) { keys[k] = 1; });
    var out = [];
    Object.keys(keys).sort().forEach(function (k) {
      var a = dayLine(before[k]), b = dayLine(after[k]);
      if (a !== b) out.push({ date: k, before: a, after: b });
    });
    return out;
  }

  function finishChange(before, title, notes) {
    rebuildCourseLabels();
    var diff = diffDays(before.days, state.days);
    lastUndo = before;
    /* 计划里"今天"这一格常常不动：已经打过卡的日子系统一律不覆盖。
     * 不说这一句，用户改完设置看今天的任务没变，就会以为设置没生效。 */
    if (diff.length && diff[0].date > todayKey()) {
      notes = ['今天（' + fmtDate(todayKey(), false) + '）已经动过了，系统不覆盖动过的日子，' +
        '所以这次变化从 ' + fmtDate(diff[0].date, false) + ' 开始。'].concat(notes || []);
    }
    /* 结构性改动也留一条记录。用户下次想知道"计划什么时候变过"时，
     * 不用凭记忆翻日期。真正的对比面板照旧马上弹。 */
    if (diff.length && title) {
      var adj = logAdjust('task', title, '这次改动影响到了 ' + diff.length + ' 天。', {
        changes: diff.slice(0, 2),
        changedCount: diff.length,
      });
      state.ui.adjustSeenAt = adj.at;
      if (lastUndo) lastUndo.adjustId = adj.id;
    }
    save();
    render();
    /* 一天都没变，但计划整体可能变了（基础期多长、听课总时长、排不排得完）。
     * 这时候也要说清楚，不然就是"我改了，怎么什么都没发生"。 */
    if (!diff.length) {
      if (notes && notes.length) return showNote(title, notes);
      toast(title);
      return;
    }
    showChangePanel(title, diff, notes);
  }

  function showChangePanel(title, diff, notes) {
    var shown = diff.slice(0, 4);
    var more = diff.length - shown.length;
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="modal-title">' + esc(title) + '</div>' +
        (notes && notes.length
          ? '<div class="tiny muted" style="margin:-4px 0 10px;line-height:1.6">' +
              notes.map(function (n) { return esc(n); }).join('<br>') + '</div>'
          : '') +
        '<div class="modal-msg">影响到了 ' + diff.length + ' 天：</div>' +
        '<div class="chg-list">' +
          shown.map(function (d) {
            return '<div class="chg-row">' +
              '<div class="chg-date">' + fmtDate(d.date, false) + ' ' + weekdayName(d.date) + '</div>' +
              '<div class="chg-before">' + (d.before ? esc(d.before) : '（本来没有）') + '</div>' +
              '<div class="chg-after">' + (d.after ? esc(d.after) : '（现在没有）') + '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
        (more > 0 ? '<div class="modal-msg">…还有 ' + more + ' 天</div>' : '') +
        '<div class="row" style="gap:10px;margin-top:16px">' +
          '<button class="btn grow" data-act="chg-undo">撤销</button>' +
          '<button class="btn primary grow" data-act="chg-ok">知道了</button>' +
        '</div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------------
   * 计划调整记录
   *
   * 打卡本身只记录事实；真正动到未来安排的是跨周、断更、阶段变化
   * 和用户自己删改任务。这些变化都记一条，今日页有新记录时出提示。
   * ------------------------------------------------------------------- */

  function logAdjust(type, title, detail, extra) {
    state.adjustLog = state.adjustLog || [];
    var entry = {
      id: uid('adj-'),
      at: new Date().toISOString(),
      date: todayKey(),
      type: type || 'plan',
      title: title || '计划有调整',
      detail: detail || '',
    };
    if (extra) Object.keys(extra).forEach(function (k) { entry[k] = extra[k]; });
    state.adjustLog.push(entry);
    if (state.adjustLog.length > 40) state.adjustLog = state.adjustLog.slice(-40);
    return entry;
  }

  function unseenAdjust() {
    var seen = (state.ui && state.ui.adjustSeenAt) || '';
    var list = (state.adjustLog || []).filter(function (e) { return e.at > seen; });
    return list.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  }

  function adjustRowHtml(e) {
    var changes = (e.changes || []).map(function (d) {
      return '<div class="adj-change">' +
        '<span class="adj-date">' + fmtDate(d.date, false) + '</span>' +
        '<span class="adj-before">' + esc(d.before || '（没有）') + '</span>' +
        '<span class="adj-arrow">→</span>' +
        '<span class="adj-after">' + esc(d.after || '（取消）') + '</span>' +
      '</div>';
    }).join('');
    return '<div class="adj-item">' +
      '<div class="adj-h"><b>' + esc(e.title) + '</b><span>' + fmtDate(e.date || e.at.slice(0, 10), false) + '</span></div>' +
      (e.detail ? '<div class="adj-d">' + esc(e.detail) + '</div>' : '') +
      (changes ? '<div class="adj-changes">' + changes +
        (e.changedCount > (e.changes || []).length
          ? '<div class="adj-more">还有 ' + (e.changedCount - e.changes.length) + ' 天也有变化</div>'
          : '') + '</div>' : '') +
    '</div>';
  }

  function openAdjustLog() {
    var list = (state.adjustLog || []).slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    state.ui = state.ui || {};
    state.ui.adjustSeenAt = new Date().toISOString();
    save();
    render();   // 先把今日页那条"计划有调整"收掉，再打开明细
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="modal-title">计划调整记录</div>' +
        '<div class="modal-msg">计划什么时候变过、为什么变，都记在这里。</div>' +
        '<div class="adj-list">' +
          (list.length ? list.slice(0, 12).map(adjustRowHtml).join('')
                       : '<div class="adj-empty">还没有调整记录</div>') +
        '</div>' +
        '<div class="row" style="margin-top:16px">' +
          '<button class="btn primary block" data-act="adj-close">知道了</button>' +
        '</div>' +
      '</div>';
  }

  function save() { store.save(state); }

  /* ---------------------------------------------------------------------
   * 打卡记录：追加式
   * 每次改状态都往 task.log 里追加一条带时间戳的记录，
   * task.status 只是"最新一条的结果"，方便别处照旧读取。
   * 好处：能画出"哪天学的、几点学的"；将来做多设备同步也不会冲突。
   * ------------------------------------------------------------------- */

  function setTaskStatus(task, status, extra) {
    task.status = status;
    task.log = task.log || [];
    var entry = { at: new Date().toISOString(), status: status };
    if (extra) Object.keys(extra).forEach(function (k) { entry[k] = extra[k]; });
    task.log.push(entry);
    /* 一天里改来改去的话只留最近 20 条，别把存储撑爆 */
    if (task.log.length > 20) task.log = task.log.slice(-20);
  }

  /* 某个任务"什么时候完成的"——学习档案要用 */
  function taskDoneAt(task) {
    if (!task.log) return null;
    for (var i = task.log.length - 1; i >= 0; i--) {
      if (task.log[i].status === 'done') return task.log[i].at;
    }
    return null;
  }

  function reRender() { render(); }

  /* ---------------------------------------------------------------------
   * 课的"第几节"是算出来的，不是存下来的
   * 任务的存储里只记"这个模块听 0.5 节"，编号在显示时按顺序推。
   * 这样删掉中间一节、再插回来、或者在末尾接新课，编号都会自己对齐。
   * ------------------------------------------------------------------- */

  var courseLabels = {};

  function rebuildCourseLabels() {
    var pos = {};
    courseLabels = {};
    /* 换过考试的人，上一轮听过的节次不再编号。
     * 从上一轮听到的地方往后接着编，否则新一轮又是"第 1 节"。 */
    var inh = (state.profile && state.profile.inheritedProgress) || {};
    MODULES.forEach(function (m) { pos[m.id] = Number(inh[m.id]) || 0; });
    Object.keys(state.days || {}).sort().forEach(function (k) {
      (state.days[k].tasks || []).forEach(function (t) {
        if (t.kind !== 'course' || t.noSeq) return;   // 补记的不占节次编号
        var from = pos[t.moduleId] || 0;
        var units = t.units || 1;
        courseLabels[t.id] = window.YT.engine.lessonLabel(from, units);
        pos[t.moduleId] = from + units;
      });
    });
  }

  /* 课程"完成一半"时，拆出一条"续听"任务。
   * 原任务继续算半节进度；续听任务不占节次编号，只把剩下那半节接上。
   * 当天没做完的话，第二天的顺延逻辑会把它排到最前面。 */
  function syncHalfCourse(day, task) {
    if (!day || !task || task.kind !== 'course') return false;
    var tasks = day.tasks || [];
    var existing = null;
    tasks.forEach(function (t) {
      if (t.continuationOf === task.id) existing = t;
    });

    if (task.status !== 'half' || task.skip) {
      if (existing) {
        /* 续听也可能被标成一半，从而再拆出一条子续听。
         * 撤回时要把整条链一起收掉，不能留下孤儿任务。 */
        var pendingIds = [task.id];
        for (var i = 0; i < pendingIds.length; i++) {
          var pid = pendingIds[i];
          tasks.slice().forEach(function (t) {
            if (t.continuationOf !== pid) return;
            pendingIds.push(t.id);
            tasks.splice(tasks.indexOf(t), 1);
          });
        }
        return true;
      }
      return false;
    }

    var remUnits = Math.max(0.25, Math.round(((task.units || 1) / 2) * 4) / 4);
    var remMinutes = Math.max(5, Math.round((task.minutes || 0) / 2));
    if (existing) {
      existing.units = remUnits;
      existing.amounts = remUnits;
      existing.minutes = remMinutes;
      existing.amountText = '约 ' + remMinutes + ' 分钟';
      return false;
    }

    var m = MODULE_BY_ID[task.moduleId] || {};
    var cont = {
      id: uid('cont-'),
      moduleId: task.moduleId,
      moduleName: task.moduleName,
      kind: 'course',
      title: (m.short || task.moduleName || '课程') + ' · 续听',
      detail: '把没听完的部分接着听完',
      amounts: remUnits,
      units: remUnits,
      amountText: '约 ' + remMinutes + ' 分钟',
      minutes: remMinutes,
      status: 'todo',
      actualMinutes: null,
      noSeq: true,
      continuation: true,
      continuationOf: task.id,
    };
    var idx = tasks.indexOf(task);
    tasks.splice(idx + 1, 0, cont);
    return true;
  }

  /* 老数据里可能已经有"完成一半"的课，但当时还没有续听任务。
   * 每次跨天检查时补一遍，保证顺延逻辑接得上。 */
  function syncAllHalfCourses() {
    Object.keys(state.days || {}).sort().forEach(function (k) {
      var day = state.days[k];
      if (!day || day.isRest) return;
      (day.tasks || []).slice().forEach(function (t) {
        if (t.kind === 'course') syncHalfCourse(day, t);
      });
    });
  }

  function taskDetail(t) {
    if (t.kind === 'course' && courseLabels[t.id]) return courseLabels[t.id];
    return t.detail || t.amountText || '';
  }

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

  /* ---------------------------------------------------------------------
   * 体验模式：只把 app.js 的内部能力借给 js/demo.js
   *
   * 演示用的界面、按钮和全部逻辑都在 js/demo.js 里，这里只开一扇门。
   * 【正式上架时怎么删干净】见 js/demo.js 文件顶部，一共四处。
   * ------------------------------------------------------------------- */

  function demoCtx() {
    return {
      getState: function () { return state; },
      todayKey: todayKey,
      realTodayKey: realTodayKey,
      save: save,
      render: render,
      go: go,
      toast: toast,
      askConfirm: askConfirm,
      dailyRoll: dailyRoll,
      regenFuture: regenFuture,
      setTaskStatus: setTaskStatus,
      /* 回到问卷第一页。跟设置页那个「重新开始」是同一条路。 */
      hardReset: function () {
        state = store.reset();
        draft = null;
        save();
        render();
      },
    };
  }
  window.YT.demoCtx = demoCtx;

  /* 体验模式开着没有。demo.js 没加载（正式版）时永远是 false。 */
  function demoOn() {
    return !!(window.YT.demo && window.YT.demo.enabled());
  }

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
        var touched = E.dayTouched(day);
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
      var touched = E.dayTouched(day);
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
      var touched = E.dayTouched(day);
      if (!touched) delete state.days[k];
    });

    /* 本次重排不再套用上周的调整系数，否则连着点两次会越排越少 */
    state.weekMark = state.weekMark || {};
    state.weekMark[E.weekKeyOf(tk)] = true;

    E.ensureAhead(state, tk, 14);
    refreshForecast(tk);
    save();

    if (onDone) onDone();
  }

  /* ---------------------------------------------------------------------
   * 设置改完立刻重排
   *
   * 以前是"改完点最下面那个按钮"，但设置页很长，改数字的地方离按钮很远，
   * 用户改完往下一看计划没动，就会以为设置没生效。
   * 现在改完自动重排：输入框停手 400ms 就重算，点选类即刻重算。
   * ------------------------------------------------------------------- */

  var regenTimer = null;
  var regenNote = null;        // { text: '…', busy: true/false }
  var regenNoteTimer = null;
  var regenDoneText = null;    // 有些改动想说自己那句话（比如"已切到全自动"）

  function setRegenNote(text, busy) {
    regenNote = { text: text, busy: !!busy };
    paintRegenNote();
    clearTimeout(regenNoteTimer);
    if (!busy) {
      /* 过一会儿收回默认那句，免得一直挂着一串旧数字 */
      regenNoteTimer = setTimeout(function () {
        regenNote = null;
        paintRegenNote();
      }, 6000);
    }
  }

  function paintRegenNote() {
    var el = document.querySelector('.regen-note');
    if (!el) return;
    el.textContent = regenNote ? regenNote.text : '设置改完会自动重排后面的计划';
    el.className = 'regen-note' + (regenNote ? (regenNote.busy ? ' busy' : ' done') : '');
  }

  function scheduleRegen(delay, doneText) {
    /* 只在设置页自动重排。别的页面（问卷、记录成绩）改了不算设置 */
    if (!state.profile || (state.ui.screen || '') !== 'settings') return;
    regenDoneText = doneText || null;
    setRegenNote('正在按新设置重排…', true);
    clearTimeout(regenTimer);
    regenTimer = setTimeout(runRegenNow, delay === undefined ? 400 : delay);
  }

  function runRegenNow() {
    regenTimer = null;
    if (!state.profile) return;
    var before = planSnapshot();
    generateAll();
    setRegenNote(regenDoneText || planDiffShort(before));
    regenDoneText = null;
    reRenderKeepPlace();
  }

  /* 重排之后要把设置页里那些跟着变的数字（听课进度、顺序表、强度表）刷新一遍。
   * 但用户多半还在输入框里，所以重画之后把焦点和光标位置还回去。 */
  function reRenderKeepPlace() {
    /* 记住"刚才在操作哪个控件"，重画之后把焦点还回去。
     *
     * 选择器必须一路精确到 data-k / data-m / data-v，只写 data-act 的话
     * 永远命中页面上第一个同类控件——原来就是这个毛病：点第 3 个折叠分组，
     * 焦点却被还给第 1 个，浏览器为了让它可见把整页滚上去，
     * 表现就是"一展开就被弹回上面"。 */
    var ae = document.activeElement;
    var focusSel = null;
    if (ae && ae.getAttribute && ae.getAttribute('data-act')) {
      var parts = ['[data-act="' + ae.getAttribute('data-act') + '"]'];
      ['data-k', 'data-m', 'data-v'].forEach(function (a) {
        var v = ae.getAttribute(a);
        if (v !== null && v !== '') parts.push('[' + a + '="' + v + '"]');
      });
      focusSel = parts.join('');
    }
    var sel = null;
    try { sel = ae ? ae.selectionStart : null; } catch (e) { sel = null; }
    var sy = window.scrollY;

    render();
    window.scrollTo(0, sy);

    if (!focusSel) return;
    var el = document.querySelector(focusSel);
    if (!el || !el.focus) return;
    /* preventScroll：焦点可以还，页面不许动 */
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    if (sel !== null && sel !== undefined) {
      try { el.setSelectionRange(sel, sel); } catch (e) { /* number 输入框不支持，忽略 */ }
    }
  }

  /* 通用折叠块。计划详情、设置里的各个分组都用它。
   * 展开状态放在 state.ui.folds 里，记住上次的选择。 */
  function foldOpen(key, defaultOpen) {
    state.ui = state.ui || {};
    state.ui.folds = state.ui.folds || {};
    var v = state.ui.folds[key];
    return v === undefined ? !!defaultOpen : !!v;
  }

  /* 统一的展开箭头。
   * 以前用 '⌃' '⌄' 两个字符，问题是它们在不同字体里的粗细、大小、基线都不一样，
   * 而且换字符等于换布局，没法做旋转动画。SVG 一套到底。 */
  function chevIcon() {
    return '<svg class="chev-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M8.4 10.2l3.6 3.6 3.6-3.6"/></svg>';
  }

  /* 右箭头。用在"点了会去另一个地方"的按钮上——比如「调整阶段」跳去设置页。
   * 光写文字的话，用户会以为那只是几个字。 */
  function arrowRight() {
    return '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10.4 7.4l4.6 4.6-4.6 4.6"/></svg>';
  }

  function foldBlock(key, title, note, body, defaultOpen) {
    var open = foldOpen(key, defaultOpen);
    return '<div class="fold' + (open ? ' open' : '') + '">' +
      '<button class="fold-head" data-act="fold-toggle" data-k="' + esc(key) + '">' +
        '<span class="fold-t">' + esc(title) + '</span>' +
        (note ? '<span class="fold-n">' + esc(note) + '</span>' : '') +
        chevIcon() +
      '</button>' +
      '<div class="fold-body">' + body + '</div>' +
    '</div>';
  }

  /* 给设置页底部那行状态用的一句话，短，够看明白 */
  function planDiffShort(b) {
    var a = planSnapshot();
    var parts = [];
    function row(label, from, to) {
      if (from === null || to === null || from === to) return;
      parts.push(label + ' ' + from + '→' + to);
    }
    row('基础期', b.base, a.base);
    row('强化期', b.strong, a.strong);
    row('听课时长', b.hours, a.hours);
    if (!parts.length) return '已按新设置重排，后面的计划没有变化';
    return '已重排：' + parts.join('　·　') +
      (a.left > 0 ? '　（还有 ' + a.left + ' 节课排不进去）' : '');
  }

  /* 重排前后各拍一张，用来告诉用户"这次到底改了什么"。
   * 以前点完重排只弹一句 toast 就跳回今日页，而变化全在计划页最上面，
   * 于是"我改了课节数，计划怎么没反应"这个问题一定会出现。 */
  function planSnapshot() {
    var stages = (state.roadmap && state.roadmap.stages) || [];
    var lc = (state.roadmap && state.roadmap.lessonCheck) || {};
    var fc = state.forecast || {};
    var units = 0;
    MODULES.forEach(function (m) { units += E.targetUnits(m, state.profile); });
    return {
      base: stages[0] ? stages[0].studyDays : null,
      strong: stages[1] ? stages[1].studyDays : null,
      hours: lc.totalMinutes ? Math.round(lc.totalMinutes / 60) : null,
      units: Math.round(units * 10) / 10,
      left: (fc.courseLeft && fc.courseLeft.units) || 0,
      leftHours: fc.courseLeft ? Math.round(fc.courseLeft.minutes / 60) : 0,
    };
  }

  function planDiff(b) {
    var a = planSnapshot();
    var lines = [];
    function row(label, from, to, unit) {
      if (from === null || to === null || from === to) return;
      lines.push(label + '：' + from + unit + ' → ' + to + unit);
    }
    row('基础期', b.base, a.base, ' 天');
    row('强化期', b.strong, a.strong, ' 天');
    row('听课总时长', b.hours, a.hours, ' 小时');
    row('要听的课', b.units, a.units, ' 节');
    if (a.left > 0) {
      lines.push('注意：按现在的时间，有 ' + a.left + ' 节课（约 ' + a.leftHours +
        ' 小时）到最后也排不进去。这种情况再减课节数，日期不会变，只是把后面的科目顶上来。');
    }
    if (!lines.length) {
      lines.push('排出来的任务没有变化。');
      lines.push('因为"今天该听哪节课、做哪几道题"跟总共打算听多少节没有关系——');
      lines.push('改这个数字影响的是"课什么时候听完、基础期多长"，这些在计划页最上面。');
    }
    return lines;
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
  /* 按现在的进度往前推一遍，看课什么时候听完、什么时候进套卷。
   * 阶段表也换成这一份——它跟每天实际排的阶段是同一套算法算的。 */
  function refreshForecast(tk) {
    if (!state.profile || !state.roadmap) return;
    state.forecast = E.forecast(state, tk);
    if (state.forecast) state.roadmap.stages = state.forecast.stages;
    /* 课排不完才需要算"砍多少"。现在阶段按日期切，
     * 砍课不会让强化期变长，只会让剩下的课排得进去。 */
    state.cutPlan = null;
    if (state.forecast && state.forecast.courseLeft &&
        state.forecast.courseLeft.units > 0.5) {
      state.cutPlan = courseCutPlan(tk);
    }
  }

  /* 砍课比例不是拍脑袋来的：把每科课节数按同一个比例缩小，
   * 重新预测一遍，看剩下的课能不能排完。试几档就够。
   * 试的时候临时改 profile，马上改回来——中间没有异步操作，安全。 */
  function courseCutPlan(tk) {
    var p = state.profile;
    var cur = {};
    MODULES.forEach(function (m) {
      var v = p.courseUnits && p.courseUnits[m.id];
      cur[m.id] = (v === undefined || v === null || v === '') ? m.courseUnits : v;
    });

    /* 最多建议砍一半。再往下砍就不是"优化"了，是让用户别听课了，
     * 那种情况该走"提高倍速 / 每天加时间"这两条路。 */
    var tries = [0.85, 0.7, 0.6, 0.5];
    var best = null;
    var sumBefore = 0;
    MODULES.forEach(function (m) {
      if (m.essay) return;
      sumBefore += cur[m.id];
    });

    for (var i = 0; i < tries.length; i++) {
      var f = tries[i];
      var sumAfter = 0;
      MODULES.forEach(function (m) {
        if (m.essay) return;
        var nv = Math.max(0.5, Math.round(cur[m.id] * f * 2) / 2);
        sumAfter += nv;
        p.courseUnits[m.id] = nv;
      });
      var fc = E.forecast(state, tk);
      MODULES.forEach(function (m) { p.courseUnits[m.id] = cur[m.id]; });
      /* 已经砍到低了，再建议就是骚扰 */
      if (sumAfter >= sumBefore - 0.001) continue;
      var left = fc && fc.courseLeft ? fc.courseLeft.units : 0;
      best = {
        factor: f,
        left: Math.round(left * 10) / 10,
        fit: left <= 0.5,
      };
      if (best.fit) break;
    }
    if (!best || best.factor >= 1) return null;

    /* 挑一个模块当例子说给用户听，比一堆百分比好懂 */
    var sample = null;
    MODULES.forEach(function (m) {
      if (m.essay || sample || !cur[m.id]) return;
      sample = { short: m.short, from: cur[m.id], to: Math.max(0.5, Math.round(cur[m.id] * best.factor * 2) / 2) };
    });
    best.sample = sample;
    return best;
  }

  function dailyRoll() {
    var tk = todayKey();

    /* 老数据里"完成一半"的课没有续听任务，先补齐再走顺延。 */
    syncAllHalfCourses();
    var beforeDays = JSON.parse(JSON.stringify(state.days || {}));

    /* 0. 断了很久回来：把断更期间"排了但一下都没碰"的日子清掉。
     * 必须放在顺延之前，否则那些天没做完的东西会被顺延到未来，
     * 用户一打开就是一屁股债——这正是他要卸载的时刻。 */
    var ri = E.applyRestart(state, tk);
    /* 休息日不弹：这天本来就没任务，"今天先按六成来"是句废话。
     * 不记 restartSeenOn，下一个学习日会正常弹出来。 */
    if (ri && !E.isRest(E.parseKey(tk), state.profile) && state.ui.restartSeenOn !== tk) {
      state.ui.restartSeenOn = tk;
      pendingRestart = ri;
      logAdjust('restart', '停了一段时间，已经帮你接上',
        '上次学习是 ' + fmtDate(ri.lastKey, false) + '，中间隔了 ' + ri.missed +
        ' 个学习日。断更期间的旧安排已经清掉，今天先按' +
        (ri.level === 'long' ? '六成' : '八成') + '的量来。');
    }

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
    refreshForecast(tk);

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

      /* 记一条带具体变化的调整记录。数量不多，只看前三天，
       * 剩下的在"全部记录"里告诉用户还有几天也变了。 */
      rebuildCourseLabels();
      var weekDiff = diffDays(beforeDays, state.days);
      logAdjust('week', '已按上周完成情况重排本周',
        '上周完成 ' + pct(roll.ws.rate) + '，' +
        (roll.rule ? roll.rule.label : '保持原计划') +
        '。本周还没开始的安排已经按这个结果排好。',
        { changes: weekDiff.slice(0, 3), changedCount: weekDiff.length });
    }

    /* 阶段不看月份看进度。第一次运行只记基线，之后变了才留记录。
     * 休息日没有 stage，跳过，免得把休息日误判成"回到基础期"。 */
    var todayDay = state.days[tk];
    if (todayDay && !todayDay.isRest) {
      var stageNow = todayDay.stage || 'base';
      if (!state.lastStage) {
        state.lastStage = stageNow;
      } else if (state.lastStage !== stageNow) {
        logAdjust('stage', '进入' + (STAGE_NAME[stageNow] || stageNow),
          '累计学到这个阶段了，后面的安排会换一种节奏。');
        state.lastStage = stageNow;
      }
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
      mode: 'semi',
      courseUnits: {},
      benchmarks: {},
    };
    MODULES.forEach(function (m) { d.courseUnits[m.id] = m.courseUnits; });
    return d;
  }

  /* 基础水平决定"你手上有多少课，实际要听多少"。
   * 之前这个值定义了却从来没用过，导致选"我考过"照样排全部课程。 */
  function applyBaseToUnits() {
    var preset = window.YT.BASE_PRESET[draft.base] || window.YT.BASE_PRESET.zero;
    var f = preset.courseFactor === undefined ? 1 : preset.courseFactor;
    MODULES.forEach(function (m) {
      draft.courseUnits[m.id] = Math.max(0, Math.round(m.courseUnits * f));
    });
  }

  function baseFactor() {
    var preset = window.YT.BASE_PRESET[draft.base] || window.YT.BASE_PRESET.zero;
    return preset.courseFactor === undefined ? 1 : preset.courseFactor;
  }

  function baseLabel() {
    var hit = window.YT.BASE_OPTIONS.filter(function (o) { return o.id === draft.base; })[0];
    return hit ? hit.label : '';
  }

  /* 把当前问卷内容拼成一份临时档案，用来试算 */
  function draftProfile() {
    var E2 = window.YT.engine;
    var today = E2.toKey(new Date());
    var p = {
      examDate: draft.examDate || E2.toKey(E2.addDays(new Date(), 120)),
      base: draft.base,
      weekdayMinutes: draft.weekdayMinutes,
      weekendMinutes: draft.weekendMinutes,
      restDays: draft.restDays,
      lessonMinutes: Number(draft.lessonMinutes) || 150,
      speed: Number(draft.speed) || 1.5,
      mode: draft.mode || 'semi',
      courseUnits: draft.courseUnits,
      benchmarks: {},
      strength: {},
    };
    MODULES.forEach(function (m) { p.strength[m.id] = 'normal'; });
    return p;
  }

  /* 用当前问卷内容试算一遍，让用户看到"我的选择产生了什么结果" */
  function previewPlan() {
    var E2 = window.YT.engine;
    try { return E2.buildRoadmap(draftProfile(), E2.toKey(new Date())); } catch (e) { return null; }
  }

  /* 阶段天数得用真实引擎跑一遍才算得准。
   * buildRoadmap 里的阶段是按日期比例切的，改时长/倍速它一动不动，
   * 于是用户会觉得"改了没反应"——其实是他那里的数字本来就决定不了这几行。 */
  function previewForecast() {
    var E2 = window.YT.engine;
    var p = draftProfile();
    var today = E2.toKey(new Date());
    try {
      var st = { profile: p, roadmap: E2.buildRoadmap(p, today), days: {}, scores: [] };
      E2.ensureAhead(st, today, 14);
      return E2.forecast(st, today);
    } catch (e) { return null; }
  }

  function previewHtml() {
    var p = draftProfile();
    var fc = previewForecast();
    if (!fc) return '';
    var totalUnits = 0;
    var E2 = window.YT.engine;
    MODULES.forEach(function (m) {
      totalUnits += E2.targetUnits(m, p);
    });
    var totalMinutes = Math.round(totalUnits * E2.effectiveLesson(p));

    var st = fc.stages;
    var f = baseFactor();
    var note = f < 1
      ? '因为你说「' + baseLabel() + '」，每科的课都按 ' + Math.round(f * 100) + '% 折算过了，你可以在这上面直接改。'
      : '这些数字可以按你手上的课直接改。';

    /* 时间/节数明摆着排不完的时候，就在这一步说清楚。
     * 这是用户正在挑数字的时候，比在计划页再说一遍有用得多。 */
    var warn = (fc.courseLeft && fc.courseLeft.units > 0)
      ? '<div class="pv-warn">按这个时间和节数，行测课排不完：还有 <b>' + fc.courseLeft.units +
        ' 节</b>（约 ' + Math.round(fc.courseLeft.minutes / 60) +
        ' 小时）到最后也听不了。可以把节数调少、倍速调高，或者每天多留点时间。</div>'
      : '';

    return '<div class="preview-card">' +
      '<div class="pv-title">按现在的填写，你的计划会是这样</div>' +
      '<div class="pv-row"><span>要听的课</span><b>' + totalUnits + ' 节 · 约 ' +
        Math.round(totalMinutes / 60) + ' 小时</b></div>' +
      '<div class="pv-row"><span>基础期</span><b>' + st[0].studyDays + ' 个学习日</b></div>' +
      '<div class="pv-row"><span>强化期</span><b>' + st[1].studyDays + ' 个学习日</b></div>' +
      '<div class="pv-row"><span>冲刺期</span><b>' + st[2].studyDays + ' 个学习日</b></div>' +
      warn +
      '<div class="pv-note">' + esc(note) + '</div>' +
    '</div>';
  }

  var ONBOARD_STEPS = 7;

  /* 问卷最后一步下面那块"按现在的填写，你的计划会是这样"。
   * 改数字时只换这一块、不整页重画（整页重画会把正在输入的框踢掉）。
   *
   * 这里必须三个输入框都调：课节数、每节课时长、听课倍速。
   * 以前只有课节数调了，改时长和倍速预览纹丝不动，
   * 用户就会以为"改了没反应"——这个坑踩过一次。 */
  function refreshObPreview() {
    var pv = document.getElementById('ob-preview');
    if (pv) pv.innerHTML = previewHtml();
  }

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
        '<input class="input" type="date" data-act="set-exam-draft" value="' + esc(draft.examDate) + '"></div>' +
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
      /* 用哪种模式：这三档决定今日页上你能改多少东西 */
      body = '<h2>你想怎么用它？</h2><p class="lead">这个以后在设置里随时能改。</p>';
      body += '<button class="opt ' + (draft.mode === 'auto' ? 'on' : '') + '" data-act="pick-mode" data-v="auto">' +
              '<div class="t">全自动</div><div class="d">系统排什么你就做什么，界面最干净。适合完全没头绪、想被带着走的人。</div></button>';
      body += '<button class="opt ' + (draft.mode === 'semi' ? 'on' : '') + '" data-act="pick-mode" data-v="semi">' +
              '<div class="t">半自动（推荐）</div><div class="d">系统排，但每天可以自己换、跳过、加练。适合大多数人备考。</div></button>';
      body += '<button class="opt ' + (draft.mode === 'manual' ? 'on' : '') + '" data-act="pick-mode" data-v="manual">' +
              '<div class="t">自己排</div><div class="d">系统只排听课，刷题和复盘都由你自己安排。适合已经知道自己缺什么、有自己的节奏的人。</div></button>';

    } else if (step === 6) {
      body = '<h2>每个模块你打算听多少节课？</h2>' +
             '<p class="lead">数字随时能改：想多听就往上加，没听或不想听就往下减。</p>' +
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
      body += '<div id="ob-preview">' + previewHtml() + '</div>';
      body += '<button class="btn ghost block" style="margin-top:14px" data-act="no-course">我不用听课，直接开始刷题</button>';
      body += '<div class="footnote">每节课的时长和倍速决定一节课实际要花多久。这些数字直接决定基础期排多少天。</div>';
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
      mode: draft.mode || 'semi',
      courseUnits: draft.courseUnits,
      benchmarks: draft.benchmarks || {},
      strength: {},
      phasePlan: { custom: false },
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
    /* 计划时长本身永远排第一档：大多数情况其实就是照着计划的时间做完的 */
    var mults = [1, 0.6, 0.8, 1.25, 1.5];
    var out = [];
    var base = Math.max(1, Math.round(minutes));
    mults.forEach(function (x) {
      var v = x === 1 ? base : Math.max(5, Math.round(minutes * x / 5) * 5);
      if (out.indexOf(v) === -1) out.push(v);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function renderTask(t, dateKey) {
    var cls = t.status === 'done' ? 'done' : t.status === 'half' ? 'half' : '';
    var rowCls = (t.status === 'done' ? ' is-done' : '') + (t.skip ? ' is-skipped' : '');
    var body =
      /* 标题这一行也能点：手机上人的第一反应是戳任务名，
       * 而不是去戳左边那个 24 像素的小圈。 */
      '<div class="task-top" data-act="cycle" data-date="' + dateKey + '" data-task="' + esc(t.id) + '">' +
        '<span class="task-title">' + esc(t.title) + '</span>' +
        '<span class="task-min">' + fmtMinutes(t.minutes) + '</span>' +
      '</div>' +
      (taskDetail(t) ? '<div class="task-detail">' + esc(taskDetail(t)) + '</div>' : '') +
      ((t.carried || t.status === 'half' || t.userAdded || t.continuation)
        ? '<div class="task-meta">' +
            (t.continuation ? '<span class="pill warn">续听</span>'
                      : t.focus ? '<span class="pill plain">主攻</span>'
                      : t.review ? '<span class="pill plain">回顾</span>'
                      : (t.userAdded ? '<span class="pill plain">自己加的</span>' : '')) +
            (t.carried ? '<span class="pill warn">顺延</span>' : '') +
            (t.status === 'half' ? '<span class="pill">完成一半</span>' : '') +
          '</div>'
        : '');
    if (t.skip) {
      body += '<div class="task-meta"><span class="pill plain">今天不做</span></div>';
    }

    var canTime = (t.kind === 'practice' || t.kind === 'essay' || t.kind === 'paperset');
    if (t.status === 'done' && canTime) {
      if (t.actualMinutes) {
        body += '<div class="task-meta"><span class="pill plain">实际 ' + fmtMinutes(t.actualMinutes) + '</span></div>';
      } else {
        body += '<div class="actual"><div class="hint">实际用了多久？点一下就行，不点也没关系</div><div class="chips">';
        actualOptions(t.minutes).forEach(function (v) {
          body += '<button class="chip" data-act="set-actual" data-date="' + dateKey + '" data-task="' + esc(t.id) + '" data-min="' + v + '">' + v + ' 分</button>';
        });
        body += '<button class="chip" data-act="skip-actual" data-date="' + dateKey + '" data-task="' + esc(t.id) + '">跳过</button>';
        body += '</div>';
        /* 预设档位永远不可能刚好，给一个能自己填的地方 */
        body += '<div class="custom-time">' +
          '<span>或自己填</span>' +
          '<input type="number" min="1" max="600" step="1" inputmode="numeric" ' +
            'data-act="actual-custom" data-date="' + dateKey + '" data-task="' + esc(t.id) + '" ' +
            'placeholder="' + t.minutes + '">' +
          '<span>分钟</span></div>';
        body += '</div>';
      }
    }

    return '<div class="task' + rowCls + '">' +
      '<button class="tick ' + cls + '" data-act="cycle" data-date="' + dateKey + '" data-task="' + esc(t.id) + '" aria-label="标记完成"></button>' +
      '<div class="task-body">' + body + '</div>' +
      '<button class="del" data-act="task-menu" data-date="' + dateKey + '" data-task="' + esc(t.id) + '" title="改这一项">⋯</button>' +
    '</div>';
  }

  function reviewFirst(tasks) {
    var review = [], rest = [];
    (tasks || []).forEach(function (t) {
      (t && t.review ? review : rest).push(t);
    });
    return review.concat(rest);
  }

  function taskListHtml(tasks, dateKey) {
    var ordered = reviewFirst(tasks);
    var hasReview = ordered.some(function (t) { return t && t.review; });
    var head = hasReview ? '<div class="task-group">先回顾，再做今天的任务</div>' : '';
    var doneHead = (hasReview && ordered.some(function (t) { return !t.review; }))
      ? '<div class="task-group">今天的任务</div>' : '';
    var out = '', doneHeadUsed = false;
    ordered.forEach(function (t) {
      if (!t) return;
      if (hasReview && !t.review && !doneHeadUsed) {
        out += doneHead;
        doneHeadUsed = true;
      }
      out += renderTask(t, dateKey);
    });
    return head + out;
  }

  function renderToday() {
    var tk = todayKey();
    if (!state.days[tk]) { E.ensureAhead(state, tk, 14); save(); }
    var day = state.days[tk];
    var profile = state.profile;

    if (!day) {
      app.innerHTML = '<div class="screen"><div class="top"><h1>计划已结束</h1>' +
        '<div class="sub">考试日已经过去了。要备考下一场的话，点下面这个。</div>' +
        '<button class="btn primary block" data-act="switch-open" style="margin-top:18px">备考下一场 →</button>' +
        '</div></div>';
      return renderTabbar('today');
    }

    var st = S.streak(state, tk);
    var doneCount = (day.tasks || []).filter(function (t) { return t.status === 'done'; }).length;
    /* 今天不做的那些不算"欠着的"，别让 4 项里的 1 项白占分母 */
    var skippedCount = (day.tasks || []).filter(function (t) { return t.skip; }).length;
    var totalCount = (day.tasks || []).length - skippedCount;
    /* 今日页顶部只留一行，所以课程进度压成一个很小的数字。
     * 不新增卡片，避免把今日页拉长。 */
    var cp = E.courseProgress(state);
    var cDone = 0, cNeed = 0;
    MODULES.forEach(function (m) {
      var need = E.targetUnits(m, profile);
      if (need <= 0) return;
      cNeed += need;
      cDone += Math.min(need, cp[m.id] || 0);
    });
    var courseText = cNeed > 0
      ? '听课 ' + (Math.round(cDone * 10) / 10) + '/' + (Math.round(cNeed * 10) / 10) + ' 节'
      : '';
    /* 体验模式：今日页最上面那条模拟工具。正式版这里永远是空串。 */
    var demoBar = demoOn() ? window.YT.demo.bar() : '';

    var head = demoBar + '<div class="today-head">' +
      '<div class="date">' + fmtDate(tk, true) + '　' + weekdayName(tk) + '</div>' +
      '<h1>' + (day.isRest ? '今天休息' : '今天') + '</h1>' +
      '<div class="state">' +
        '<i>' + stageLabel(day.stage) + '</i>' +
        (courseText ? ' · ' + courseText : '') +
        (totalCount ? ' · 已完成 <b>' + doneCount + ' / ' + totalCount + '</b> 项' : '') +
        (skippedCount ? ' · <span class="muted">' + skippedCount + ' 项今天不做</span>' : '') +
        (st > 1 ? ' · 连续 <b>' + st + '</b> 天' : '') +
      '</div>' +
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
    var tasksHtml = taskListHtml(day.tasks || [], tk);
    if (!tasksHtml) tasksHtml = '<div class="task"><div class="task-body muted tiny">今天没有安排任务。</div></div>';

    var allDone = (day.tasks || []).length > 0 && (day.tasks || []).every(function (t) { return t.status === 'done'; });

    /* 留白 = 当天容量 − 系统排的 − 自己加的。够 15 分钟才提示，太少提示反而尴尬。 */
    var cap = E.budgetFor(E.parseKey(tk), profile, day.stage).total;
    var freeMin = Math.max(0, cap - s.planned - s.extraPlanned);
    var freeHtml = (freeMin >= 15 && !state.ui.addingExtra)
      ? '<div class="free-note">基础任务之外还剩 <b>' + fmtMinutes(freeMin) +
        '</b>，你可以自己安排</div>'
      : '';

    /* 太久没练到的模块提醒一下。8 天没出现就提示。 */
    var stale = staleModules(tk, 8);
    var staleHtml = stale.length
      ? '<div class="stale-note">' +
          '<b>' + esc(stale[0].module.short) + '</b> 已经 ' + stale[0].gap + ' 天没练到了' +
          (stale.length > 1 ? '（还有 ' + (stale.length - 1) + ' 个模块也是）' : '') +
          '，要不要今天补一组？' +
          '<button class="btn sm ghost" style="margin-top:8px" data-act="extra-quick" data-m="' + stale[0].module.id + '">加一组</button>' +
        '</div>'
      : '';

    /* 你老是自己加同一科，那就直接问要不要排进日常 */
    var skipSug = (usageMode() === 'auto') ? null : skipSuggestion();
    var sug = skipSug ? null : prefSuggestion();
    var sugHtml = skipSug
      ? '<div class="pref-note">你最近五天有 <b>' + skipSug.days + '</b> 天把 <b>' +
          esc(skipSug.name) + '</b> 划掉了，要不要干脆把它调成「减少」？' +
          '<div class="row" style="gap:8px;margin-top:8px">' +
            '<button class="btn sm primary" data-act="reduce-yes" data-m="' + skipSug.moduleId + '">调成减少</button>' +
            '<button class="btn sm ghost" data-act="reduce-no" data-m="' + skipSug.moduleId + '">不用，我就偶尔</button>' +
          '</div></div>'
      : sug
      ? '<div class="pref-note">你最近五天有 <b>' + sug.days + '</b> 天主动多练了 ' +
          '<b>' + esc(sug.name) + '</b>，要不要排进日常安排？' +
          '<div class="row" style="gap:8px;margin-top:8px">' +
            '<button class="btn sm primary" data-act="pref-yes" data-m="' + sug.moduleId + '">排进去</button>' +
            '<button class="btn sm ghost" data-act="pref-no" data-m="' + sug.moduleId + '">不用</button>' +
          '</div></div>'
      : '';

    /* 跨周、断更、阶段变化时，计划确实动过。
     * 不弹窗，只在今日页顶部留一条，点进去能看到具体改了哪几天。 */
    var adjNew = unseenAdjust();
    var adjHtml = adjNew.length
      ? '<div class="adjust-banner">' +
          '<div class="ab-body">' +
            '<div class="ab-t">计划有调整' + (adjNew.length > 1 ? '（' + adjNew.length + ' 条）' : '') + '</div>' +
            '<div class="ab-d">' + esc(adjNew[0].title) + '</div>' +
          '</div>' +
          '<button class="btn sm primary" data-act="adj-open">看看</button>' +
        '</div>'
      : '';
    var pw = phaseWarning(tk);
    var pwHtml = pw
      ? '<div class="pref-note"><b>' + esc(pw.title) + '</b><br>' + esc(pw.body) +
          '<div class="row" style="gap:8px;margin-top:8px">' +
            pw.actions.map(function (a) {
              return '<button class="btn sm ' + (a.primary ? 'primary' : 'ghost') + '" data-act="' + a.act + '"' +
                (a.f ? ' data-f="' + a.f + '"' : '') +
                (a.to ? ' data-to="' + a.to + '"' : '') + '>' + esc(a.label) + '</button>';
            }).join('') +
          '</div></div>'
      : '';

    app.innerHTML = '<div class="screen">' + head +
      adjHtml +
      (pwHtml ? '<div class="section">' + pwHtml + '</div>' : '') +
      (sugHtml ? '<div class="section">' + sugHtml + '</div>' : '') +
      (staleHtml ? '<div class="section">' + staleHtml + '</div>' : '') +
      (allDone ? '<div class="section"><div class="done-note">今天全部完成</div></div>' : '') +

      '<div class="section"><div class="card tasks">' + tasksHtml + '</div></div>' +

      '<div class="section">' + freeHtml + extraFormHtml() +
        (state.ui.addingExtra ? '' :
          (usageMode() === 'auto'
            ? '<div class="tiny muted" style="text-align:center">现在是全自动模式，只跟着做就行。' +
              '想换科目、跳过多做点，去设置里改成半自动。</div>'
            : '<div class="row" style="gap:8px">' +
                '<button class="btn grow secondary" data-act="extra-open">加一项</button>' +
                '<button class="btn grow primary" data-act="focus-open">今天主攻一科</button>' +
                '</div>')) +
      '</div>' +

      (usageMode() === 'manual'
        ? (function () {
            var rh = manualReviewHint(day);
            return '<div class="section"><div class="free-note">刷题由你自己安排：点上面的「加一项」或「今天主攻一科」，' +
              '系统只保留了该听哪节课。</div>' +
              (rh
                ? '<div class="review-hint">今天排了 <b>' + fmtMinutes(rh.practiceMin) +
                  '</b> 刷题，建议留 <b>' + fmtMinutes(rh.minutes) + '</b> 复盘：把做错的题重做一遍、记下错因。' +
                  '<div class="row" style="gap:8px;margin-top:8px">' +
                    '<button class="btn sm primary" data-act="add-review" data-v="' + rh.minutes + '">加上复盘</button>' +
                    '<button class="btn sm ghost" data-act="no-review">今天不用</button>' +
                  '</div></div>'
                : '') +
              '</div>'
            ;
          })()
        : '') +

      '<div class="section"><p class="section-title">今天感觉</p>' +
        '<div class="moods">' +
          moodBtn('easy', '太轻松', day.mood) +
          moodBtn('ok', '刚好', day.mood) +
          moodBtn('tired', '有点累', day.mood) +
          moodBtn('hard', '太难了', day.mood) +
        '</div>' +
        moodPreviewHtml() +
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
      '<div class="mp-note">按你最近一次选的感受算的。改选别的会立刻重排。</div>' +
    '</div>';
  }

  function moodBtn(id, label, cur) {
    return '<button class="mood ' + (cur === id ? 'on' : '') + '" data-act="mood" data-v="' + id + '">' + label + '</button>';
  }

  /* 某个模块多久没出现在刷题任务里了。从来没练过的，从计划开始那天算。 */
  function staleModules(tk, days) {
    var last = {};
    Object.keys(state.days || {}).sort().forEach(function (k) {
      if (k > tk) return;
      (state.days[k].tasks || []).forEach(function (t) {
        if (t.kind === 'practice' && !t.userAdded) last[t.moduleId] = k;
      });
    });
    var start = (state.roadmap && state.roadmap.startKey) || tk;
    var out = [];
    MODULES.forEach(function (m) {
      if (m.essay) return;
      var st = (state.profile.strength && state.profile.strength[m.id]) || 'normal';
      if (st === 'skip') return;
      var lk = last[m.id] || start;
      var gap = E.dayDiff(lk, tk);
      if (gap >= days) out.push({ module: m, gap: gap, last: lk });
    });
    return out.sort(function (a, b) { return b.gap - a.gap; });
  }

  /* 到了用户定的阶段边界，但内容没完成时提醒一次。
   * 进度不再是硬门槛，所以必须有人把"没做完"这件事说出来。 */
  function phaseWarning(tk) {
    var rm = state.roadmap;
    if (!rm || !rm.phasePlan) return null;
    var stage = E.stageOf(tk, rm);
    var fc = state.forecast;
    var left = fc && fc.courseLeft ? fc.courseLeft.units : 0;

    if (stage !== 'base' && left > 0.5) {
      var acts = [{ act: 'phase-open', label: '调整阶段', primary: false }];
      if (state.cutPlan) acts.push({ act: 'cut-course', f: state.cutPlan.factor, label: '帮我砍课', primary: true });
      return {
        title: '基础期结束了，还有 ' + left + ' 节行测课没听完',
        body: '已经放进强化期继续听。想按时开始大量刷题，建议砍课或把基础期往后延。',
        actions: acts,
      };
    }

    if (stage === 'sprint' && rm.phasePlan.sprintStart) {
      var daysIn = E.dayDiff(rm.phasePlan.sprintStart, tk);
      if (daysIn >= 0 && daysIn <= 7) {
        var ready = E.readyModuleCount(state.profile, E.moduleSets(state));
        var need = CFG.stage.sprintMinModules;
        if (ready < need) {
          return {
            title: '冲刺期开始了，但专项还没刷够',
            body: '现在有 ' + ready + ' / ' + need + ' 个模块过完一轮。建议优先补高分模块，数量和常识放弃专项，只做套卷里遇到的题。',
            actions: [{ act: 'goto', to: 'plan', label: '去计划页看', primary: true }],
          };
        }
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------------
   * 自己加任务
   * 系统排的是"基础任务"，装不下一整组的时间留白，用户想加什么自己加。
   * ------------------------------------------------------------------- */

  /* 六板块 + 申论。判断推理底下有三个子模块，需要再选一次。 */
  var EXTRA_GROUPS = [
    { id: 'zlfx', name: '资料' },
    { id: 'yy',   name: '言语' },
    { id: 'pd',   name: '判断', subs: ['pdlj', 'pdtx', 'pddl'] },
    { id: 'sl',   name: '数量' },
    { id: 'cs',   name: '常识' },
    { id: 'zzll', name: '政治' },
    { id: 'slw',  name: '申论' },
  ];

  var extraDraft = { group: null, moduleId: null, type: 'practice' };

  /* 往哪一天加。今日页默认今天，计划页点某天的"＋"就指向那一天。 */
  function extraTargetDay() { return state.ui.extraDate || todayKey(); }

  function extraFormHtml() {
    if (!state.ui.addingExtra) return '';
    var g = extraDraft.group;
    var chips = EXTRA_GROUPS.map(function (x) {
      return '<button class="chip ' + (g === x.id ? 'on' : '') + '" data-act="extra-group" data-v="' + x.id + '">' + x.name + '</button>';
    }).join('');

    var sub = '';
    if (g === 'pd') {
      sub = '<div class="chips" style="margin-top:8px">' +
        ['pdlj', 'pdtx', 'pddl'].map(function (id) {
          var m = MODULE_BY_ID[id];
          return '<button class="chip ' + (extraDraft.moduleId === id ? 'on' : '') + '" data-act="extra-module" data-v="' + id + '">' + esc(m.short.replace('判推', '')) + '</button>';
        }).join('') + '</div>';
    }

    /* 申论也有课，所以三种都要给：听课 / 小题 / 大作文 */
    var typeRow = '';
    if (g === 'slw') {
      typeRow = '<div class="chips" style="margin-top:10px">' +
        typeChip('course', '听课') + typeChip('small', '小题') + typeChip('big', '大作文') +
      '</div>';
    } else if (g) {
      typeRow = '<div class="chips" style="margin-top:10px">' +
        typeChip('practice', '刷题') + typeChip('course', '听课') +
      '</div>';
    }

    if (g === 'slw') {
      if (extraDraft.type === 'course') {
        var effS = window.YT.engine.effectiveLesson(state.profile);
        sub += '<div class="ef-qty"><label>听几节</label>' +
          '<input type="number" min="0.5" step="0.5" value="1" data-act="extra-qty" data-per="' + effS + '" data-size="1">' +
          '<span>节 · 约 <b id="ef-min">' + Math.round(effS) + '</b> 分钟</span></div>';
      }
    } else if (g && (g !== 'pd' || extraDraft.moduleId)) {
      var m2 = MODULE_BY_ID[extraDraft.moduleId || g];
      var dstage = (state.days[extraTargetDay()] || {}).stage || 'base';
      var per = window.YT.unitMinutesFor(m2, dstage, state.profile);
      var eff = window.YT.engine.effectiveLesson(state.profile);
      var isCourse = extraDraft.type === 'course';
      if (isCourse) {
        sub += '<div class="ef-qty"><label>听几节</label>' +
          '<input type="number" min="0.5" step="0.5" value="1" data-act="extra-qty" data-per="' + eff + '" data-size="1">' +
          '<span>节 · 约 <b id="ef-min">' + Math.round(eff) + '</b> 分钟</span></div>';
        sub += '<div class="param-note" style="margin-top:8px">听课时长按你的倍速算过，一节约 ' +
          Math.round(eff) + ' 分钟。自己加的听课会算进课程进度。</div>';
      } else {
        sub += '<div class="ef-qty"><label>做几组</label>' +
          '<input type="number" min="1" step="1" value="1" data-act="extra-qty" data-per="' + per + '" data-size="' + (m2.setSize || 20) + '">' +
          '<span>组 · 约 <b id="ef-min">' + Math.round((m2.setSize || 20) * per) + '</b> 分钟</span></div>';
        sub += '<div class="param-note" style="margin-top:8px">一组 ' + (m2.setSize || 20) + ' 题。' +
          '想高强度刷专题就直接填大一点——填 10 就是 ' + (10 * (m2.setSize || 20)) + ' 题，系统不拦着。</div>';
      }
    }

    var canAdd = g && (g === 'slw' || extraDraft.moduleId || g !== 'pd');
    return '<div class="extra-form">' +
      '<div class="ef-title">我想加一项</div>' +
      '<div class="chips">' + chips + '</div>' +
      typeRow +
      sub +
      '<div class="row" style="gap:8px;margin-top:12px">' +
        '<button class="btn sm ghost" data-act="extra-cancel">取消</button>' +
        '<button class="btn sm primary grow" data-act="extra-add">加进来</button>' +
      '</div>' +
    '</div>';
  }

  function typeChip(v, label) {
    return '<button class="chip ' + (extraDraft.type === v ? 'on' : '') + '" data-act="extra-type" data-v="' + v + '">' + label + '</button>';
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
      var skipped = !st.studyDays;
      var range = st.startKey ? (fmtDate(st.startKey, false) + ' – ' + fmtDate(st.endKey, false)) : '—';
      return '<div class="stage' + cur + (skipped ? ' skipped' : '') + '">' +
        '<div class="stage-idx">' + (i + 1) + '</div>' +
        '<div class="grow"><div class="stage-name">' + st.name + (st.key === todayStage ? ' · 进行中' : '') + '</div>' +
        '<div class="stage-date">' + range + ' · ' + (skipped ? '跳过' : st.studyDays + ' 个学习日') + '</div>' +
        '<div class="tiny muted" style="margin-top:3px">' + esc(st.goal) + '</div></div></div>';
    }).join('');

    var phaseNote = '';
    if (rm.phasePlan) {
      phaseNote = '<div class="tiny muted" style="margin-top:10px">' +
        (rm.phasePlan.custom
          ? '这是你自己改的阶段日期。'
          : '这是系统按你的课量和考试日期推荐的阶段日期。') +
        (rm.phasePlan.courseOverflow
          ? ' 按现在的行测课量，基础期加强化期也装不下全部课程，建议砍课或把基础期往后延。'
          : '') +
      '</div>';
    }

    /* 预测：课哪天听完、哪天进入冲刺。阶段日期现在由用户定或系统推荐。 */
    var fc = state.forecast;
    var fcHtml = '';
    if (fc && fc.courseDoneKey && fc.sprintKey) {
      var sprintLeft = E.countStudyDays(fc.sprintKey, fc.examKey, state.profile);
      if (!fc.courseLeft || fc.courseLeft.units <= 0.5) {
        fcHtml = '<div class="forecast-note">按现在的安排：<b>' + fmtDate(fc.courseDoneKey, false) +
          '</b> 听完所有行测课，<b>' + fmtDate(fc.sprintKey, false) + '</b> 进入冲刺期，之后有 <b>' +
          sprintLeft + '</b> 个学习日做套卷。<br>' +
          '<span class="muted">阶段日期可以在上面的「调整阶段」里改。</span></div>';
      } else {
        fcHtml = '<div class="forecast-note">冲刺期从 <b>' + fmtDate(fc.sprintKey, false) +
          '</b> 开始，之后有 <b>' + sprintLeft + '</b> 个学习日做套卷。<br>' +
          '<span class="muted">但按现在的课量，课排不完，下面会给出砍课建议。</span></div>';
      }
    }

    /* 听课体检 */
    var lc = rm.lessonCheck;
    var checkHtml = '';
    /* 老数据里可能没有这个字段（那时候还没算强化期），先兜一下 */
    var capH = isFinite(lc && lc.capacityMinutes) ? Math.round(lc.capacityMinutes / 60) : 0;
    var cp = state.cutPlan;
    if (cp && fc && fc.courseLeft && fc.courseLeft.units > 0.5) {
      /* 课排不完时，系统必须替用户做取舍：先砍课，保刷题。 */
      checkHtml = '<div class="section"><div class="card" style="background:var(--accent-s);box-shadow:none">' +
        '<div style="font-weight:600;color:var(--accent)">课排不完，建议砍课</div>' +
        '<div class="tiny" style="margin-top:4px;color:var(--ink-2)">' +
          '按现在的阶段日期和课量，有 <b>' + fc.courseLeft.units + ' 节行测课</b>（约 ' +
          Math.round(fc.courseLeft.minutes / 60) + ' 小时）在基础期和强化期里排不进去，' +
          '到冲刺期会被丢掉。</div>' +
        '<div class="tiny" style="margin-top:6px;color:var(--ink-3)">' +
        '刷题是提分主力，课是输入。建议把行测各科的课节数砍掉约 <b>' +
        Math.round((1 - cp.factor) * 100) + '%</b>' +
        (cp.sample ? '（比如' + cp.sample.short + '从 ' + cp.sample.from + ' 节减到 ' + cp.sample.to + ' 节）' : '') +
        (cp.fit
          ? '，剩下的课就能在基础期和强化期里排完。</div>'
          : '；即使砍一半，还会差 <b>' + cp.left + ' 节</b>，建议同时把基础期往后延，或者提高每天可用时间。</div>') +
        '<button class="btn sm primary" style="margin-top:10px" data-act="cut-course" data-f="' + cp.factor + '">帮我砍</button>' +
        '<button class="btn sm ghost" style="margin-top:10px;margin-left:8px" data-act="goto" data-to="settings">我自己调</button>' +
        '</div></div>';
    } else if (lc && !lc.fit) {
      checkHtml = '<div class="section"><div class="card" style="background:var(--accent-s);box-shadow:none">' +
        '<div style="font-weight:600;color:var(--accent)">课时量偏大</div>' +
        '<div class="tiny" style="margin-top:4px;color:var(--ink-2)">' +
        '听课要 <b>' + Math.round(lc.totalMinutes / 60) + ' 小时</b>，' +
        '但基础期加强化期只放得下 <b>' + capH + ' 小时</b>。会挤压刷题。</div>' +
        '<div class="tiny" style="margin-top:6px;color:var(--ink-3)">' +
        '办法：提高倍速、少听几节、或者把每天的时间调高。</div>' +
        '<button class="btn sm ghost" style="margin-top:10px" data-act="goto" data-to="settings">去调整</button>' +
        '</div></div>';
    } else if (fc && fc.courseLeft && fc.courseLeft.units > 0) {
      /* 每天排多少听课是按"当天时间的固定比例"算的。
       * 课多到排不完的时候，减少几节不会让日期提前——只是把后面的科目顶上来。
       * 这事不说清楚，用户改完课节数会觉得"改了没反应"。 */
      checkHtml = '<div class="section"><div class="card" style="background:var(--accent-s);box-shadow:none">' +
        '<div style="font-weight:600;color:var(--accent)">听课排不完</div>' +
        '<div class="tiny" style="margin-top:4px;color:var(--ink-2)">' +
        '按现在的时间，有 <b>' + fc.courseLeft.units + ' 节行测课</b>（约 ' +
        Math.round(fc.courseLeft.minutes / 60) + ' 小时）到最后也塞不进去，会在冲刺期被丢掉。</div>' +
        '<div class="tiny" style="margin-top:6px;color:var(--ink-3)">' +
        '这种情况下再少听几节，日期也不会变，只是把后面的科目顶上来。' +
        '要真的腾出时间：提高倍速、把每天的时间调高，或者整块砍掉一科的课。</div>' +
        '<button class="btn sm ghost" style="margin-top:10px" data-act="goto" data-to="settings">去调整</button>' +
        '</div></div>';
    } else if (lc) {
      checkHtml = '<div class="section"><div class="card" style="background:var(--primary-s);box-shadow:none">' +
        '<div class="tiny" style="color:var(--primary)">课时量排得下：听课 ' + Math.round(lc.totalMinutes / 60) +
        ' 小时。' + (fc && fc.stages[1].studyDays
          ? '专项训练有 ' + fc.stages[1].studyDays + ' 个学习日。'
          : '') + '</div>' +
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

    var adjAll = (state.adjustLog || []).slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    var adjHtml = '<div class="section">' +
      '<div class="row between" style="align-items:center">' +
        '<p class="section-title" style="margin:0">计划调整</p>' +
        '<button class="btn sm ghost" data-act="adj-open">全部记录</button>' +
      '</div>' +
      '<div class="card" style="margin-top:8px">' +
        (adjAll.length
          ? adjAll.slice(0, 3).map(adjustRowHtml).join('')
          : '<div class="tiny muted">跨周、断更或阶段变化时，会记在这里。</div>') +
      '</div>' +
    '</div>';

    /* ---- 计划视图：本周 / 两周 / 本月 ---- */
    var rangeMode = state.ui.planRange || 'week';
    var rng = planRangeFor(tk, rangeMode);
    var needStudy = E.countStudyDays(rng.startKey,
      E.toKey(E.addDays(E.parseKey(rng.endKey), 1)), profile);
    E.ensureAhead(state, tk, Math.max(14, needStudy + 1));

    var rangeBar = '<div class="segmented">' +
      segBtn('week',  '本周', rangeMode) +
      segBtn('two',   '两周', rangeMode) +
      segBtn('month', '30 天', rangeMode) +
    '</div>' +
    '<div class="row between" style="margin-top:10px;align-items:center">' +
      '<span class="range-note" style="margin:0">' + fmtDate(rng.startKey, false) + ' – ' + fmtDate(rng.endKey, false) + '</span>' +
      '<button class="pillbtn" data-act="batch-open">批量排' + arrowRight() + '</button>' +
    '</div>';

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
    var tDone = 0, tNeed = 0;
    var progRows = MODULES.map(function (m) {
      var need = E.targetUnits(m, profile);
      if (need <= 0) return '';
      var done = Math.min(need, prog[m.id] || 0);
      tDone += done; tNeed += need;
      return '<div class="prog">' +
        '<div class="prog-name">' + esc(m.short) + '</div>' +
        '<div class="prog-bar"><i style="width:' + Math.round(done / need * 100) + '%"></i></div>' +
        '<div class="prog-val">剩 ' + (need - done) + ' 节</div>' +
        '<button class="prog-fix" data-act="makeup" data-m="' + m.id + '">补记</button>' +
      '</div>';
    }).join('');
    var progHead = '<div class="prog-sum">共 ' + tNeed + ' 节 · 已听 ' + tDone + ' 节 · 还剩 <b>' +
      (tNeed - tDone) + '</b> 节</div>';
    var progHtml = '<div class="section"><p class="section-title">听课进度</p><div class="card">' +
      progHead + progRows + '</div></div>';

    /* 方案 A：核心的"总体节奏 + 日程"留在外面，
     * 听课进度、预测、上周表现、计划调整收进「计划详情」，默认收起。
     * 展开状态记住，常看的人不用每次点。 */
    var planDetailsBody =
      (fcHtml ? '<div class="section">' + fcHtml + '</div>' : '') +
      progHtml + logHtml + adjHtml;

    app.innerHTML = '<div class="screen">' +
      '<div class="top"><h1>我的计划</h1>' +
      '<div class="sub">距离 ' + fmtDate(profile.examDate, true) + ' 还有 ' + rm.totalStudyDays + ' 个学习日</div></div>' +

      '<div class="section"><div class="row between" style="align-items:center">' +
        '<p class="section-title" style="margin:0">总体节奏</p>' +
        '<button class="pillbtn" data-act="phase-open">调整阶段' + arrowRight() + '</button>' +
      '</div><div class="card" style="margin-top:8px">' + stagesHtml + phaseNote + '</div></div>' +
      checkHtml +
      foldBlock('plan:details', '计划详情', '更多计划信息', planDetailsBody, false) +

      '<div class="section"><p class="section-title">日程</p>' + rangeBar +
        '<div class="card" style="margin-top:10px">' + daysHtml + '</div></div>' +
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
      /* 30 天是**滚动**的：永远是"今天起 30 天"。
       * 用自然月的话，9 月 30 号那天你只能排当天——那不是自由，是坑。 */
      start = t;
      end = E.addDays(t, PLAN_WINDOW_DAYS - 1);
    }
    return { startKey: E.toKey(start), endKey: E.toKey(end) };
  }

  var PLAN_WINDOW_DAYS = 30;   // 提前排的窗口：今天起 30 天

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
    var open = !!(state.ui.expandedDays && state.ui.expandedDays[k]);
    /* 有内容才叫"可折叠"。休息日和空白天只显示一行日期，不给展开箭头。 */
    var canFold = collapsible && !isRest && !!day;
    var head = '<div class="pd-head">' +
      '<div class="pd-date">' + label + '<small>' + (d.getMonth() + 1) + '/' + d.getDate() + '</small></div>' +
      '<div class="pd-right">' +
        '<span class="pd-total">' + (isRest ? '休息' : (total ? fmtMinutes(total) : '—')) + '</span>' +
        '<button class="pd-add" data-act="extra-open-day" data-v="' + k + '" title="给这天加一项">＋</button>' +
        /* 折叠视图里右端给一个展开箭头。休息日没有内容可展开，不给箭头，
         * 免得点下去什么都不动——那种"看着能点、点了没反应"最伤信任。 */
        (canFold ? '<span class="pd-chev">' + chevIcon() + '</span>' : '') +
      '</div>' +
    '</div>';

    var formHere = (state.ui.addingExtra && state.ui.extraDate === k) ? extraFormHtml() : '';

    if (isRest) return '<div class="plan-day rest">' + head + formHere + '</div>';
    if (!day) {
      return k < tk
        ? '<div class="plan-day past">' + head + formHere + '</div>'
        : '<div class="plan-day">' + head + '<div class="pd-stage">还没排到</div>' + formHere + '</div>';
    }

    var stageName = STAGE_NAME[day.stage] || '';

    if (collapsible) {
      var kinds = [];
      reviewFirst(day.tasks || []).forEach(function (t) {
        var n = t.moduleName;
        if (kinds.indexOf(n) === -1) kinds.push(n);
      });
      var body = open
        ? '<div class="pd-stage">' + stageName + '</div><div class="pd-tasks">' + taskRows(day) + '</div>'
        : '';
      return '<div class="plan-day foldable' + (open ? ' open' : '') + '" data-act="fold-day" data-v="' + k + '">' +
        head +
        (open ? '' : '<div class="pd-brief">' + esc(kinds.join(' · ')) + '</div>') +
        body + formHere + '</div>';
    }

    return '<div class="plan-day">' + head +
      '<div class="pd-stage">' + stageName + '</div>' +
      '<div class="pd-tasks">' + taskRows(day) + '</div>' + formHere + '</div>';
  }

  function taskRows(day) {
    var ordered = reviewFirst(day.tasks || []);
    var hasReview = ordered.some(function (t) { return t && t.review; });
    var out = hasReview ? '<div class="pd-group">先回顾</div>' : '';
    var restHead = false;
    ordered.forEach(function (t) {
      if (hasReview && !t.review && !restHead) {
        out += '<div class="pd-group">今天的任务</div>';
        restHead = true;
      }
      var mark = t.status === 'done' ? '<i class="pd-mark done">✓</i>'
               : t.status === 'half' ? '<i class="pd-mark half">◐</i>' : '';
      out += '<div class="pd-task">' +
        '<span class="pd-t">' + mark + esc(t.title) + '</span>' +
        '<span class="pd-d">' + esc(taskDetail(t)) + '</span>' +
        '<span class="pd-min">' + t.minutes + ' 分</span>' +
        '<button class="del" data-act="del-task" data-date="' + day.date + '" data-task="' + esc(t.id) + '" title="删掉这项">×</button>' +
      '</div>';
    });
    return out;
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
    var scores = state.scores || [];
    var archQ = window.YT.archive.build(state, tk, (state.days[tk] || {}).stage || 'base');
    var advRows = window.YT.archive.advice(state, tk);
    var lvRows = window.YT.archive.moduleLevels(state, tk);

    var rows = timing.map(function (r) {
      var med = r.medianPerQuestion === null ? '—' : (Math.round(r.medianPerQuestion * 10) / 10) + ' 分';
      var plan = (r.suggestion !== null && r.suggestion !== r.current)
        ? '<button class="chip" data-act="apply-bench" data-m="' + r.moduleId + '" data-v="' + r.suggestion + '">' +
            r.current + ' 分 → 改用 ' + r.suggestion + ' 分</button>'
        : r.current + ' 分';
      return '<tr>' +
        '<td>' + esc(r.short) + '</td>' +
        '<td class="num">' + r.samples + '</td>' +
        '<td class="num">' + med + '</td>' +
        '<td class="num right">' + plan + '</td>' +
      '</tr>';
    }).join('');

    var anySamples = timing.some(function (r) { return r.samples > 0; });

    app.innerHTML = '<div class="screen">' +
      '<div class="top">' + pageBack() +
        '<h1>统计</h1><div class="sub">这些数字用来把计划调得越来越贴合你</div></div>' +

      '<div class="section"><div class="metrics">' +
        '<div class="metric"><div class="v">' + st + '</div><div class="k">连续打卡</div></div>' +
        '<div class="metric"><div class="v">' + o.daysStudied + '</div><div class="k">学习天数</div></div>' +
        '<div class="metric"><div class="v">' + (o.planned ? pct(o.rate) : '—') + '</div><div class="k">完成任务</div></div>' +
      '</div></div>' +

      '<div class="section"><div class="card">' +
        '<div class="row between">' +
          '<div><div style="font-weight:600">学习档案</div>' +
          '<div class="tiny muted" style="margin-top:2px">' +
            (archQ.everStudied
              ? (archQ.gap === 0 ? '今天学过' : '上次学习是 ' + archQ.gap + ' 天前') +
                ' · 累计 ' + archQ.questionTotal + ' 题 · 听课 ' + archQ.courseTotal.done + '/' + archQ.courseTotal.need + ' 节'
              : '还没有记录，打过一次卡这里就活了') +
          '</div></div>' +
          '<button class="btn sm" data-act="arch-open">查看</button>' +
        '</div>' +
      '</div></div>' +

      ((state.rounds || []).length
        ? '<div class="section"><p class="section-title">考过的</p><div class="card">' +
            (state.rounds.slice().reverse().map(function (r) {
              var s = r.summary || {};
              return '<button class="round-row" data-act="round-open" data-v="' + esc(r.id) + '">' +
                '<span class="rn">' + esc(r.name || '上一轮') + '</span>' +
                '<span class="rd">' + (r.examDate ? fmtDate(r.examDate, false) + ' 考完' : '') +
                  (s.studiedDays ? ' · 学 ' + s.studiedDays + ' 天' : '') +
                  (s.questions ? ' · ' + s.questions + ' 题' : '') + '</span>' +
                '<span class="rr">' + (s.planned ? pct(s.rate) : '') + '</span>' +
              '</button>';
            }).join('')) +
            '<div class="footnote">换考试的时候会自动存一份。想看就看，不会混进这一轮的统计里。</div>' +
          '</div></div>'
        : '') +

      '<div class="section"><div class="card">' +
        '<div class="row between">' +
          '<div><div style="font-weight:600">成绩记录</div>' +
          '<div class="tiny muted" style="margin-top:2px">' +
            (scores.length ? '已记录 ' + scores.length + ' 次 · 复盘时长按你的错误率算' : '还没记录过，复盘时长先按错误率 30% 估') +
          '</div></div>' +
          '<button class="btn sm primary" data-act="score-open">记录</button>' +
        '</div>' +
        (scores.length ? '<div class="score-list">' +
          scores.slice(-3).reverse().map(function (sc) {
            var parts = [];
            Object.keys(sc.rates || {}).forEach(function (k) {
              var m = MODULE_BY_ID[k];
              if (m && sc.rates[k] !== null && sc.rates[k] !== undefined && sc.rates[k] !== '') {
                parts.push(m.short + ' ' + Math.round(sc.rates[k] * 100) + '%');
              }
            });
            return '<div class="score-item"><b>' + fmtDate(sc.date, false) + '</b> ' + esc(sc.source || '') +
              '<div class="tiny muted" style="margin-top:2px">' + esc(parts.join(' · ')) + '</div></div>';
          }).join('') + '</div>' : '') +
      '</div></div>' +

      (advRows.length
        ? '<div class="section"><p class="section-title">按你的成绩看</p><div class="card">' +
            advRows.map(function (a) {
              var label = a.action === 'set-strong' ? '多排点' : a.action === 'set-normal' ? '让出时间' : '练专项';
              return '<div class="adv-row">' +
                '<div class="adv-t">' + esc(a.text) + '</div>' +
                (a.action
                  ? '<button class="btn sm primary" data-act="adv-do" data-a="' + a.action + '" data-m="' + a.moduleId + '">' + label + '</button>'
                  : '<span class="tiny muted">记着这一条</span>') +
              '</div>';
            }).join('') +
          '</div></div>'
        : '') +

      '<div class="section"><p class="section-title">各科在第几档</p><div class="card">' +
        lvRows.map(function (r) {
          return '<div class="lv-row">' +
            '<span class="lv-n">' + esc(r.short) + '</span>' +
            '<span class="lv-b lv' + r.level + '">' + esc(r.levelName) + '</span>' +
            '<span class="lv-s">' + esc(r.note) + '</span>' +
          '</div>';
        }).join('') +
        '<div class="footnote">只是告诉你现在在哪一档、下一步该干什么，不是关卡——' +
        '不会因为你没到目标就卡着不让往下走。没录成绩的科目按练的量估。</div>' +
      '</div></div>' +

      '<div class="section">' +
        '<p class="section-title">做题速度</p>' +
        '<div class="card">' +
          (anySamples
            ? '<table class="table"><thead><tr>' +
              '<th>模块</th><th>记录</th><th>你实际做一题</th><th class="right">计划按这个算</th>' +
              '</tr></thead><tbody>' + rows + '</tbody></table>'
            : '<div class="tiny muted">还没有记录。<br><br>打卡时如果顺手填一下实际用时，攒够 5 次我就能算出你自己做题的真实速度，然后用它来重排后面的任务量。别人拍脑袋定的计划，你可以用数据定。</div>'
          ) +
        '</div>' +
        (anySamples ? '<div class="footnote">排计划时，系统用"计划按这个算"那一列把时间换算成题量。' +
          '你记录满 5 次之后，右边会出现按钮，点一下就能换成你自己实际的用时。' +
          '（用中位数，避免某一次特殊情况把结果带偏。）</div>' : '') +
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
    renderTabbar('mine');
  }

  /* ---------------------------------------------------------------------
   * 记录：给用户看"我做过什么"
   *
   * 三条保护（都是用户定的）：
   *   只画"第一次打卡到现在"这一段 —— 开始之前的日子不画，
   *   否则一个刚上手的人看到的是一片空白，那不是激励是打击
   *   强调已有的，不强调缺的 —— 没学的日子用最淡的底色
   *   不做里程碑 —— 花样太多
   * ------------------------------------------------------------------- */

  function firstStudyKey() {
    var keys = Object.keys(state.days || {}).sort();
    for (var i = 0; i < keys.length; i++) {
      var day = state.days[keys[i]];
      if (day.isRest) continue;
      if ((day.tasks || []).some(function (t) { return t.status !== 'todo'; })) return keys[i];
    }
    return null;
  }

  /* 累计做过什么。只算打完卡的（半完成按一半）。 */
  function recordTotals(tk) {
    var out = { questions: 0, lessons: 0, minutes: 0, papers: 0 };
    Object.keys(state.days || {}).sort().forEach(function (k) {
      if (tk && k > tk) return;
      (state.days[k].tasks || []).forEach(function (t) {
        var cr = t.status === 'done' ? 1 : t.status === 'half' ? 0.5 : 0;
        if (!cr) return;
        out.minutes += t.minutes * cr;
        if (t.kind === 'practice') out.questions += (t.amount || 0) * cr;
        else if (t.kind === 'essay') out.questions += (t.amounts || 1) * cr;
        else if (t.kind === 'course') out.lessons += (t.units || 1) * cr;
        else if (t.kind === 'paperset') out.papers += cr;
      });
    });
    out.questions = Math.round(out.questions);
    out.lessons = Math.round(out.lessons * 10) / 10;
    out.minutes = Math.round(out.minutes);
    out.papers = Math.round(out.papers * 10) / 10;
    return out;
  }

  /* 某一天学了多久（分钟） */
  function dayMinutes(k) {
    var day = state.days[k];
    if (!day) return 0;
    var m = 0;
    (day.tasks || []).forEach(function (t) {
      var cr = t.status === 'done' ? 1 : t.status === 'half' ? 0.5 : 0;
      if (cr) m += t.minutes * cr;
    });
    return Math.round(m);
  }

  /* 热力图：一格一天。颜色深浅按当天学了多久，用固定的档位，
   * 这样不同周之间可以直接比。 */
  function heatLevel(mins) {
    if (!mins) return 0;
    if (mins < 60) return 1;
    if (mins < 150) return 2;
    if (mins < 300) return 3;
    return 4;
  }

  function heatmapHtml(tk) {
    var first = firstStudyKey();
    if (!first) {
      /* 还没打过卡。画一块最浅的格子做示意——比一行光秃秃的灰字像样，
       * 又用的是最淡的底色，不会让人觉得欠了一屁股账。 */
      var ghost = '';
      for (var g = 0; g < 21; g++) {
        ghost += '<i class="hm-ghost' + (g % 5 === 2 ? ' on' : '') + '"></i>';
      }
      return '<div class="hm-empty">' +
        '<div class="hm-ghost-grid">' + ghost + '</div>' +
        '<p>打过一次卡，这里就开始有颜色了</p>' +
      '</div>';
    }
    var lastD = E.parseKey(tk);
    /* 第一列对齐到那一周的周一，最后一列画到本周 */
    var firstD = E.parseKey(first);
    var back = firstD.getDay() === 0 ? 6 : firstD.getDay() - 1;
    var colStart = E.addDays(firstD, -back);
    var endBack = lastD.getDay() === 0 ? 6 : lastD.getDay() - 1;
    var lastColStart = E.addDays(lastD, -endBack);

    var cols = [];
    var d = colStart;
    var guard = 0;
    while (d <= lastColStart && guard < 60) {
      guard++;
      var cells = '';
      for (var w = 0; w < 7; w++) {
        var dd = E.addDays(d, w);
        var k = E.toKey(dd);
        if (k > tk || k < first) {
          cells += '<span class="hm-cell blank"></span>';
          continue;
        }
        var mins = dayMinutes(k);
        cells += '<span class="hm-cell lv' + heatLevel(mins) + '" title="' +
          fmtDate(k, false) + (mins ? '　' + fmtMinutes(mins) : '　没学') + '"></span>';
      }
      cols.push('<span class="hm-col">' + cells + '</span>');
      d = E.addDays(d, 7);
    }

    return '<div class="heatmap">' + cols.join('') + '</div>' +
      '<div class="hm-legend">少' +
        '<span class="hm-cell lv1"></span><span class="hm-cell lv2"></span>' +
        '<span class="hm-cell lv3"></span><span class="hm-cell lv4"></span>多' +
      '</div>';
  }

  function recMonthKey(tk) { return state.ui.recMonth || tk.slice(0, 7); }

  function shiftMonth(mkey, delta) {
    var y = Number(mkey.slice(0, 4)), m = Number(mkey.slice(5, 7)) + delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return y + '-' + (m < 10 ? '0' + m : m);
  }

  /* 按天记录：这个月每天完成了多少，点开看那天做了什么 */
  function recordCalendarHtml(tk) {
    var mkey = recMonthKey(tk);
    var y = Number(mkey.slice(0, 4)), mo = Number(mkey.slice(5, 7));
    var firstD = new Date(y, mo - 1, 1);
    var lastD = new Date(y, mo, 0);
    var back = firstD.getDay() === 0 ? 6 : firstD.getDay() - 1;
    var gridStart = E.addDays(firstD, -back);
    var fwd = lastD.getDay() === 0 ? 0 : 7 - lastD.getDay();
    var gridEnd = E.addDays(lastD, fwd);

    var heads = ['一', '二', '三', '四', '五', '六', '日']
      .map(function (w) { return '<div class="cal-head">' + w + '</div>'; }).join('');

    var cells = '';
    var d = gridStart, guard = 0;
    while (d <= gridEnd && guard < 45) {
      guard++;
      var k = E.toKey(d);
      if (d.getMonth() !== mo - 1 || k > tk) {
        cells += '<div class="cal-cell out"></div>';
      } else {
        var mins = dayMinutes(k);
        var isRest = E.isRest(d, state.profile);
        var cls = 'cal-cell rlv' + heatLevel(mins);
        if (isRest) cls += ' rest';
        if (k === tk) cls += ' today';
        if (state.ui.recDay === k) cls += ' sel';
        var label = mins ? Math.round(mins / 60 * 10) / 10 + 'h' : (isRest ? '休' : '');
        cells += '<button class="' + cls + '" data-act="rec-pick" data-v="' + k + '">' +
          '<span class="cal-d">' + d.getDate() + '</span>' +
          '<span class="cal-mini">' + label + '</span></button>';
      }
      d = E.addDays(d, 1);
    }

    var canNext = mkey < tk.slice(0, 7);
    return '<div class="row between" style="align-items:center;margin-bottom:8px">' +
        '<button class="ord-mv" data-act="rec-month" data-v="-1" aria-label="上个月">←</button>' +
        '<span style="font-size:14px;font-weight:600">' + y + ' 年 ' + mo + ' 月</span>' +
        '<button class="ord-mv" data-act="rec-month" data-v="1"' + (canNext ? '' : ' disabled') + ' aria-label="下个月">→</button>' +
      '</div>' +
      '<div class="cal-grid">' + heads + cells + '</div>';
  }

  /* 选中那天的明细 */
  function recordDayHtml() {
    var k = state.ui.recDay;
    if (!k || !state.days[k]) return '';
    var day = state.days[k];
    var st = { done: [], half: [], skip: [], todo: [] };
    (day.tasks || []).forEach(function (t) {
      if (t.skip) st.skip.push(t);
      else if (t.status === 'done') st.done.push(t);
      else if (t.status === 'half') st.half.push(t);
      else st.todo.push(t);
    });
    function row(t, mark) {
      return '<div class="rec-row"><span class="rm">' + mark + '</span>' +
        '<span class="rt">' + esc(t.title) + '</span>' +
        '<span class="rv">' + fmtMinutes(t.minutes) + '</span></div>';
    }
    var body =
      st.done.map(function (t) { return row(t, '✓'); }).join('') +
      st.half.map(function (t) { return row(t, '◐'); }).join('') +
      st.skip.map(function (t) { return row(t, '—'); }).join('') +
      st.todo.map(function (t) { return row(t, '○'); }).join('');

    return '<div class="rec-day">' +
      '<div class="rec-day-head">' + fmtDate(k, true) + '　' + weekdayName(k) +
        (dayMinutes(k) ? '　学了 ' + fmtMinutes(dayMinutes(k)) : '　没有记录') + '</div>' +
      (body || '<div class="tiny muted">这天没有任务</div>') +
    '</div>';
  }

  /* ---------------------------------------------------------------------
   * 我的：记录 + 两个入口
   *
   * 下面这一屏就是原来那一格「记录」，原样搬过来——
   * 热力图、三项累计、按天记录（月历 + 点某天看明细）都没动。
   * 只在最上面加了一条入口，统计和设置从这儿进。
   * ------------------------------------------------------------------- */

  function openInstallHelp() {
    var installed = isStandalone();
    var body;
    if (installed) {
      body = '<div class="modal-msg">你已经把它添加到桌面了。</div>' +
        '<div class="param-note">想删掉：长按桌面图标，选择「移除」或「卸载」。</div>';
    } else if (deferredInstallPrompt) {
      body = '<div class="modal-msg">这台设备支持一键添加。点下面的按钮，按提示确认就行。</div>' +
        '<button class="btn primary block" data-act="install-do" style="margin-top:14px">立即添加到桌面</button>' +
        '<div class="param-note" style="margin-top:10px">添加后会像 App 一样全屏打开，数据只存在你自己的设备上。</div>' +
        '<div class="param-note">以后不想用了：长按桌面图标 → 移除/卸载。</div>';
    } else if (isIOS()) {
      body = '<div class="modal-msg">iPhone / iPad 用 Safari 打开：</div>' +
        '<div class="param-note">1. 点底部中间的「分享」按钮<br>2. 往下找到「添加到主屏幕」<br>3. 点右上角「添加」</div>' +
        '<div class="param-note">添加后会像 App 一样全屏打开，数据只存在你自己的设备上。</div>' +
        '<div class="param-note">以后不想用了：长按桌面图标 → 移除/卸载。</div>';
    } else {
      body = '<div class="modal-msg">在浏览器菜单里找：</div>' +
        '<div class="param-note">Chrome：右上角三个点 → 「安装应用」或「添加到主屏幕」<br>' +
        'Safari：底部分享按钮 → 「添加到程序坞」</div>' +
        '<div class="param-note">以后不想用了：长按桌面图标 → 移除/卸载。</div>';
    }
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="modal-title">添加到桌面</div>' +
        body +
        '<div class="row" style="gap:10px;margin-top:16px">' +
          '<button class="btn grow" data-act="install-dismiss">不再显示这个入口</button>' +
          '<button class="btn primary grow" data-act="install-close">知道了</button>' +
        '</div>' +
      '</div>';
  }

  function renderMine() {
    var tk = todayKey();
    var totals = recordTotals(tk);
    var days = S.overall(state, tk).daysStudied;
    var first = firstStudyKey();
    var st = S.streak(state, tk);

    var statsIcon = '<path d="M6 19.4v-6M12 19.4V5.2M18 19.4v-9"/>';
    var settingsIcon = '<path d="M4 8.5h8M17 8.5h3M4 15.5h3M12 15.5h8"/>' +
      '<circle cx="14.5" cy="8.5" r="2.2"/><circle cx="9.5" cy="15.5" r="2.2"/>';
    var installIcon = '<path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 19h14"/>';

    function menuRow(to, icon, title, note) {
      return '<button class="menu-row" data-act="goto" data-to="' + to + '">' +
        '<svg class="gi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg>' +
        '<span class="mt">' + title + '</span>' +
        '<span class="mn">' + note + '</span>' +
        '<span class="chev">›</span>' +
      '</button>';
    }

    app.innerHTML = '<div class="screen">' +
      '<div class="top"><h1>我的</h1>' +
        '<div class="sub">' +
          (days
            ? '你已经坚持了 ' + days + ' 天' + (first ? '，从 ' + fmtDate(first, false) + ' 开始' : '')
            : '还没有记录，打过一次卡就开始算') +
        '</div></div>' +

      '<div class="section"><div class="card" style="padding:2px 18px">' +
        menuRow('stats', statsIcon, '数据统计', '成绩 · 档位 · 速度') +
        menuRow('settings', settingsIcon, '设置', '考试 · 时间 · 各科') +
        (installHintVisible()
          ? '<button class="menu-row" data-act="install-open">' +
              '<svg class="gi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
              'stroke-linecap="round" stroke-linejoin="round">' + installIcon + '</svg>' +
              '<span class="mt">添加到桌面</span>' +
              '<span class="mn">' + (isStandalone() ? '已经添加' : '像 App 一样打开') + '</span>' +
              '<span class="chev">›</span>' +
            '</button>'
          : '') +
      '</div></div>' +

      '<div class="section"><div class="card">' + heatmapHtml(tk) + '</div></div>' +

      '<div class="section"><div class="metrics">' +
        '<div class="metric"><div class="v">' + totals.questions + '</div><div class="k">累计做题</div></div>' +
        '<div class="metric"><div class="v">' + totals.lessons + '</div><div class="k">听课节数</div></div>' +
        '<div class="metric"><div class="v">' + Math.round(totals.minutes / 60) + '</div><div class="k">学习小时</div></div>' +
      '</div>' +
      '<div class="footnote">' +
        (st > 1 ? '现在连续 ' + st + ' 天。' : '') +
        (totals.papers ? '累计做过 ' + totals.papers + ' 套卷。' : '') +
        '听课大约 ' + Math.round(totals.lessons * E.effectiveLesson(state.profile) / 60) + ' 小时。</div>' +
      '</div>' +

      '<div class="section"><p class="section-title">按天记录</p>' +
        '<div class="card">' + recordCalendarHtml(tk) + recordDayHtml() + '</div>' +
      '</div>' +
      '</div>';
    renderTabbar('mine');
  }

  /* ---------------------------------------------------------------------
   * 工具：现在什么都没有
   *
   * 只放一句话告诉用户这里以后可能会有东西。不解释是什么、
   * 不说它和计划是什么关系——那些等真做出来再说。
   * ------------------------------------------------------------------- */

  function renderTools() {
    app.innerHTML = '<div class="screen">' +
      '<div class="top"><h1>工具</h1></div>' +
      '<div class="section"><div class="card empty-card">' +
        '<div class="empty-ico">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="4" y="4" width="7" height="7" rx="2.2"/>' +
            '<rect x="13" y="4" width="7" height="7" rx="2.2"/>' +
            '<rect x="4" y="13" width="7" height="7" rx="2.2"/>' +
            '<rect x="13" y="13" width="7" height="7" rx="2.2"/>' +
          '</svg>' +
        '</div>' +
        '<div class="empty-t">更多公考学习工具正在准备中</div>' +
        '<div class="empty-d">上线后会直接放在这里。</div>' +
      '</div></div>' +
      '</div>';
    renderTabbar('tools');
  }

  /* 二级页（统计、设置）左上角的返回 */
  function pageBack() {
    return '<button class="page-back" data-act="back">← 我的</button>';
  }

  /* 设置页里的主题选择。七个色块，点一下整站换色。
   * 色块本身的颜色用内联变量喂进去——它就是主题表里那三个值，
   * 所以以后加主题只要改 config.js，这里不用动。 */
  function themeGridHtml() {
    var themes = (window.YT && window.YT.THEMES) || [];
    if (!themes.length) return '';
    var cur = themeOf();
    return '<div class="theme-grid">' + themes.map(function (t) {
      return '<button class="theme-sw' + (t.id === cur ? ' on' : '') + '" ' +
        'data-act="set-theme" data-v="' + t.id + '" ' +
        'style="--sw:' + t.accent + ';--sw-l:' + t.lite + ';--sw-d:' + t.deep + '">' +
        '<i></i><span>' + esc(t.name) + '</span></button>';
    }).join('') + '</div>';
  }

  /* ---------------------------------------------------------------------
   * 设置
   * ------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------
   * 学习顺序：行测先学哪一科 + 申论什么时候开始
   *
   * 顺序只决定"听课的先后"。练习怎么分配还是按各科的性价比走——
   * 换个顺序不该把一套经过调校的刷题权重也带偏。
   * ------------------------------------------------------------------- */

  function orderRows() {
    var ids = E.moduleOrder(state.profile);
    var rows = ids.map(function (id, i) {
      var m = MODULE_BY_ID[id];
      if (!m) return '';
      var isEssay = !!m.essay;
      var sub = isEssay ? '<span class="unit">独立一条线</span>'
                        : '<span class="unit">' + E.targetUnits(m, state.profile) + ' 节</span>';
      /* 申论不参与行测的先后，它的起点由下面那个开关决定 */
      var arrows = isEssay ? '<span class="ord-hint">见下</span>'
        : '<button class="ord-mv" data-act="ord-up" data-m="' + id + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="上移">↑</button>' +
          '<button class="ord-mv" data-act="ord-down" data-m="' + id + '"' + (i === ids.length - 1 ? ' disabled' : '') + ' aria-label="下移">↓</button>';
      return '<div class="ord-row">' +
        '<span class="ord-n">' + (i + 1) + '</span>' +
        '<span class="ord-t">' + esc(m.short) + '</span>' + sub +
        arrows +
      '</div>';
    }).join('');
    return '<div class="order-list">' + rows + '</div>';
  }

  /* 设置里的「阶段安排」：只改两个日期。
   * 系统给推荐值，用户想自己定就改这里；改完以后阶段按日期走。 */
  function phasePlanSectionHtml() {
    var p = state.profile;
    if (!p) return '';
    var rm = state.roadmap || E.buildRoadmap(p, todayKey());
    var pp = rm.phasePlan || {};
    var rec = pp.recommended || {};
    var user = p.phasePlan || {};
    var curBaseEnd = (pp.custom && user.baseEnd) || pp.baseEnd || '';
    var curSprintStart = (pp.custom && user.sprintStart) || pp.sprintStart || '';
    var recBaseEnd = rec.baseEnd || curBaseEnd;
    var recSprintStart = rec.sprintStart || curSprintStart;
    var note = pp.custom
      ? '你现在用的是自己改的日期。系统推荐：基础期到 ' + fmtDate(recBaseEnd, false) +
        '，冲刺期从 ' + fmtDate(recSprintStart, false) + ' 开始。'
      : '这两个日期是系统按你的课量和考试日期推荐的。想自己定就直接改。';
    var warn = pp.courseOverflow
      ? '<div class="param-note" style="color:var(--danger)">按现在的行测课量，基础期加强化期也装不下全部课程。建议砍课，或者把基础期再往后延。</div>'
      : '';
    return '<div class="section" id="phase-plan">' +
      '<div class="card">' +
        '<div class="field"><label>基础期结束</label>' +
          '<input class="input" type="date" data-act="set-base-end" value="' + esc(curBaseEnd) + '"></div>' +
        '<div class="field"><label>冲刺期开始</label>' +
          '<input class="input" type="date" data-act="set-sprint-start" value="' + esc(curSprintStart) + '"></div>' +
        '<div class="param-note">' + esc(note) + '</div>' + warn +
        '<button class="btn ghost block" style="margin-top:10px" data-act="phase-reset">恢复推荐值</button>' +
      '</div></div>';
  }

  function phaseFoldNote() {
    var rm = state.roadmap;
    if (!rm || !rm.phasePlan) return '';
    var user = state.profile.phasePlan || {};
    var baseEnd = (rm.phasePlan.custom && user.baseEnd) || rm.phasePlan.baseEnd;
    var sprintStart = (rm.phasePlan.custom && user.sprintStart) || rm.phasePlan.sprintStart;
    return '基础期到 ' + fmtDate(baseEnd, false) +
           ' · 冲刺 ' + fmtDate(sprintStart, false);
  }

  function lessonFoldNote() {
    if (!state.profile) return '';
    var n = 0;
    MODULES.forEach(function (m) { n += E.targetUnits(m, state.profile); });
    return '每节 ' + state.profile.lessonMinutes + ' 分钟 · 共 ' +
           (Math.round(n * 10) / 10) + ' 节';
  }

  function strengthFoldNote() {
    if (!state.profile) return '';
    var changed = 0;
    MODULES.forEach(function (m) {
      if ((state.profile.strength[m.id] || 'normal') !== 'normal') changed++;
    });
    return changed ? changed + ' 科已调整' : '默认（正常）';
  }

  function orderFoldNote() {
    if (!state.profile) return '';
    return (state.profile.moduleOrder && state.profile.moduleOrder.length)
      ? '已自定义顺序'
      : '默认顺序';
  }

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
      var sf = window.YT.STRENGTH[cur].factor;
      var btns = ['strong', 'normal', 'light', 'skip'].map(function (k) {
        return '<button class="chip ' + (cur === k ? 'on' : '') + '" data-act="set-strength" data-m="' + m.id + '" data-v="' + k + '">' +
               window.YT.STRENGTH[k].label + '</button>';
      }).join('');
      /* 强度同时决定"听多少课"和"刷多少题"，两个都要显示出来，
       * 不然用户以为它只改了听课。 */
      var summary = sf === 0
        ? '<span style="color:var(--danger)">这一科不排</span>'
        : '听课 <b>' + E.targetUnits(m, p) + '</b> 节 · 刷题量 <b>×' + sf + '</b>';
      /* 自己点名要多刷的（C8 偏好层），单独标出来，也能一键取消 */
      var boost = (p.practiceBoost && p.practiceBoost[m.id]) || 1;
      var boostHtml = boost > 1
        ? '<div class="row between" style="margin-bottom:6px">' +
            '<span class="tiny muted">你自己点名要多练的这一科</span>' +
            '<button class="chip on" data-act="clear-boost" data-m="' + m.id + '">刷题 ×' + boost + ' · 取消</button>' +
          '</div>'
        : '';
      /* 常识很特殊：它性价比最低，很多人根本不专门学。
       * 所以不把这个决定埋在四个小按钮里，单独给一个入口和一句解释。 */
      var skipTip = m.id === 'cs'
        ? '<div class="skip-tip">' +
            '<div class="st-t">常识靠平时积累，专门刷题收益很小，很多人直接放弃。</div>' +
            (cur === 'skip'
              ? '<button class="btn sm ghost" data-act="set-strength" data-m="' + m.id + '" data-v="normal">恢复学习</button>'
              : '<button class="btn sm primary" data-act="set-strength" data-m="' + m.id + '" data-v="skip">常识不专门学</button>') +
          '</div>'
        : '';
      return '<div style="padding:9px 0;border-bottom:1px solid var(--line)">' +
        '<div class="row between" style="margin-bottom:6px"><span style="font-size:13.5px">' + esc(m.short) + '</span>' +
        '<span class="tiny muted">' + summary + '</span></div>' +
        boostHtml +
        '<div class="chips">' + btns + '</div>' +
        skipTip + '</div>';
    }).join('');

    var modeSection = '<div class="section"><p class="section-title">怎么用它</p><div class="card">' +
        '<div class="chips">' +
          [['auto', '全自动'], ['semi', '半自动'], ['manual', '自己排']].map(function (x) {
            return '<button class="chip ' + (usageMode() === x[0] ? 'on' : '') + '" data-act="set-mode" data-v="' + x[0] + '">' + x[1] + '</button>';
          }).join('') +
        '</div>' +
        '<div class="footnote">' +
          (usageMode() === 'auto'
            ? '全自动：系统排什么做什么，今日页只留打卡。'
            : usageMode() === 'manual'
              ? '自己排：系统只排听课，刷题和复盘你自己安排。'
              : '半自动：系统排，每天可以换、跳过、加练。') +
          '</div>' +
      '</div></div>';

    /* 主题。放在靠前的位置——它是最直观、最想马上试一下的一个设置。 */
    var themeSection = '<div class="section"><p class="section-title">主题色</p><div class="card">' +
        themeGridHtml() +
        '<div class="footnote">换主题只动强调色：按钮、进度条、打卡、当前阶段跟着变。' +
        '警告橙、危险红、半完成琥珀不跟着变——那些是在表达状态，换个主题就变色反而看不懂。</div>' +
      '</div></div>';

    var examSection = '<div class="section"><p class="section-title">考试与时间</p><div class="card">' +
        '<div class="field"><label>考试日期</label>' +
        '<input class="input" type="date" data-act="set-exam" value="' + esc(p.examDate) + '"></div>' +
        '<button class="btn ghost block" style="margin:-2px 0 12px" data-act="switch-open">' +
          '考完了，换下一场 →</button>' +
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
      '</div></div>';

    var phaseSection = phasePlanSectionHtml();

    var lessonSection = '<div class="section"><div class="card">' +
        '<div class="numlist">' +
          '<div class="item"><label>每节课时长</label><input type="number" min="20" step="5" data-act="set-lesson" value="' + p.lessonMinutes + '"><span class="unit">分钟</span></div>' +
          '<div class="item"><label>听课倍速</label><input type="number" min="1" max="3" step="0.1" data-act="set-speed" value="' + p.speed + '"><span class="unit">倍</span></div>' +
        '</div>' +
      '</div></div>';

    var unitsSection = '<div class="section"><p class="section-title">各模块课节数</p><div class="card">' +
        '<div class="numlist">' +
          MODULES.map(function (m) {
            var v = (p.courseUnits && p.courseUnits[m.id] !== undefined && p.courseUnits[m.id] !== '')
              ? p.courseUnits[m.id] : m.courseUnits;
            var need = E.targetUnits(m, p);
            var doneM = Math.min(need, E.courseProgress(state)[m.id] || 0);
            var sub = need > 0
              ? '<span class="unit unit-live">已听 ' + doneM + ' · 剩 ' + (need - doneM) + '</span>'
              : '';
            return '<div class="item"><label>' + esc(m.short) + '</label>' +
              '<input type="number" min="0" step="1" data-act="set-units" data-m="' + m.id + '" value="' + v + '">' +
              '<span class="unit">节</span>' + sub + '</div>';
          }).join('') +
        '</div>' +
        '<div class="footnote">数字随时能改：想多听就加，没听或不想听就减；已经听过的不重来。' +
        '实际要听 = 这个数字 × 该模块的强度（下面「强度」那一栏），' +
        '所以标着「加强」的科目会比这里填的多。</div>' +
        '<button class="btn ghost block" style="margin-top:10px" data-act="no-course-settings">不听课，全部设为 0</button>' +
      '</div></div>';

    var strengthSection = '<div class="section">' +
        '<div class="card" style="padding-top:4px;padding-bottom:4px">' + strengthRows + '</div>' +
        '<div class="footnote">有底子的选「减少」，打算放弃的选「不学」（比如数量关系）。改完立刻重排。</div>' +
      '</div>';

    var orderSection = '<div class="section"><div class="card">' +
        orderRows() +
        '<div class="footnote">只决定听课的先后。练题怎么分配还是按各科的性价比走，' +
        '换个顺序不会把刷题权重也带偏。已经听过的课不受影响。</div>' +
      '</div>' +
      '<div class="card" style="margin-top:10px">' + essayStartRow() + '</div>' +
      '</div>';

    var advancedSection = '<div class="section"><div class="card">' +
        advancedRows() +
      '</div></div>';

    var dataSection = '<div class="section"><div class="card">' +
        '<button class="btn block" data-act="export">导出数据（备份用）</button>' +
        '<div style="height:8px"></div>' +
        '<button class="btn block" data-act="import">导入数据</button>' +
        '<div style="height:8px"></div>' +
        '<button class="btn block danger" data-act="wipe">重新开始（回到问卷第一页）</button>' +
        (state.ui.installHintDismissed
          ? '<div style="height:8px"></div><button class="btn ghost block" data-act="install-restore">恢复「添加到桌面」入口</button>'
          : '') +
        '<div class="footnote">计划、打卡记录和统计都会清空。想留个底，先点上面的「导出数据」。</div>' +
      '</div></div>';

    app.innerHTML = '<div class="screen">' +
      '<div class="top">' + pageBack() +
        '<h1>设置</h1><div class="sub">改完立刻生效，后面的计划会自动重排</div></div>' +

      modeSection + themeSection + examSection +

      foldBlock('settings:phase', '阶段安排', phaseFoldNote(), phaseSection, false) +
      foldBlock('settings:lesson', '听课与课节数', lessonFoldNote(), lessonSection + unitsSection, false) +
      foldBlock('settings:strength', '各模块强度', strengthFoldNote(), strengthSection, false) +
      foldBlock('settings:order', '学习顺序与申论', orderFoldNote(), orderSection, false) +
      foldBlock('settings:advanced', '高级参数', '默认已调好', advancedSection, false) +
      foldBlock('settings:data', '数据', '备份与重置', dataSection, false) +

      '<div class="sticky-cta above-tabs">' +
        '<div class="regen-note' + (regenNote ? (regenNote.busy ? ' busy' : ' done') : '') + '">' +
          esc(regenNote ? regenNote.text : '设置改完会自动重排后面的计划') +
        '</div>' +
      '</div>' +
      '</div>';
    renderTabbar('mine');
  }

  /* 高级参数：只影响"排多少"，不影响"排什么"，所以随便调也不会把计划调坏 */
  function advancedRows() {
    var t = (state.profile && state.profile.tuning) || {};
    function val(k) {
      if (t[k] !== undefined && t[k] !== null && t[k] !== '') return t[k];
      /* 申论占比在配置文件里是按阶段存的，取基础期那个当推荐值 */
      if (k === 'essayShare') return (CFG.essayShare && CFG.essayShare.base) || 0.35;
      return CFG[k];
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
           row('maxPracticePerModule', '单条任务最长', 1, '分钟', '120',
               '超了就拆成几条。不影响一天总共能刷多少。') +
           row('maxLessonUnitsPerDay', '单日听课上限', 1, '节', '3', '一天最多听几节课。') +
           moduleParamRows() +
           '<button class="btn ghost block" style="margin-top:12px" data-act="reset-tuning">全部恢复推荐值</button>';
  }

  /* 申论从哪个阶段开始学 */
  function essayStartRow() {
    var cur = (state.profile.tuning && state.profile.tuning.essayStartStage) || 'base';
    function btn(v, label) {
      return '<button class="' + (v === cur ? 'on' : '') + '" data-act="set-essay-start" data-v="' + v + '">' + label + '</button>';
    }
    return '<div class="param-row">' +
      '<div class="param-head"><span class="param-label">申论什么时候开始</span>' +
      '<span class="param-rec">推荐 一开始就学</span></div>' +
      '<div class="segmented" style="margin-top:8px">' +
        btn('base', '一开始就学') + btn('strengthen', '强化期') + btn('sprint', '冲刺期') +
      '</div>' +
      '<div class="param-note">选"冲刺期"的话，前面完全不排申论，到冲刺期再开始。申论靠积累，越晚开始越吃力。</div>' +
    '</div>';
  }

  /* 各模块的训练参数：一组多少题、目标正确率、考试限时 */
  function moduleParamRows() {
    var rows = MODULES.filter(function (m) { return !m.essay; }).map(function (m) {
      function pv(k) { return window.YT.moduleParam(m, state.profile, k); }
      var tr = window.YT.moduleParam(m, state.profile, 'targetRate');
      var trVal = (tr === null || tr === undefined) ? '' : Math.round(tr * 100);
      return '<div class="train-row">' +
        '<div class="tr-name">' + esc(m.short) + '</div>' +
        '<div class="tr-fields">' +
          '<label>一组<input type="number" min="1" step="1" data-act="set-module" data-m="' + m.id + '" data-k="setSize" value="' + pv('setSize') + '">题</label>' +
          '<label>目标<input type="number" min="0" max="100" step="1" data-act="set-module" data-m="' + m.id + '" data-k="targetRate" data-scale="100" value="' + trVal + '" placeholder="待设">%</label>' +
          '<label>限时<input type="number" min="1" step="1" data-act="set-module" data-m="' + m.id + '" data-k="examMinutes" value="' + pv('examMinutes') + '">分</label>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="param-row"><div class="param-head">' +
      '<span class="param-label">各模块训练参数</span>' +
      '<span class="param-rec">按国考量给的默认值</span></div>' +
        '<div class="param-note">一组 = 套卷里这个模块有多少题。目标正确率是练到多少算过关，' +
        '限时是考试时该分到多少分钟。</div>' +
        rows +
        '<div class="param-note">数量、常识没给默认正确率，这两个很多人直接放弃。你自己定。</div>' +
    '</div>';
  }

  /* ---------------------------------------------------------------------
   * 底部导航
   * ------------------------------------------------------------------- */

  function renderTabbar(active) {
    /* 图标用内联 SVG：比 CSS 拼出来的方块精致得多，也不占内存 */
    var ICON = {
      today: '<circle cx="12" cy="12" r="8.6"/><path d="M8.4 12.2l2.5 2.5 4.7-5.4"/>',
      plan: '<rect x="3.6" y="5" width="16.8" height="15.4" rx="3"/><path d="M3.6 9.8h16.8M8.2 3.4v3.2M15.8 3.4v3.2"/>',
      tools: '<rect x="4" y="4" width="7" height="7" rx="2.2"/><rect x="13" y="4" width="7" height="7" rx="2.2"/><rect x="4" y="13" width="7" height="7" rx="2.2"/><rect x="13" y="13" width="7" height="7" rx="2.2"/>',
      mine: '<circle cx="12" cy="8.4" r="3.6"/><path d="M5.6 19.6c0-3.4 2.9-5.6 6.4-5.6s6.4 2.2 6.4 5.6"/>',
    };
    var tabs = [
      { id: 'today', label: '今日' },
      { id: 'plan', label: '计划' },
      { id: 'tools', label: '工具' },
      { id: 'mine', label: '我的' },
    ];
    /* 统计和设置是「我的」下面的二级页，底部导航还亮「我的」那一格 */
    var on = (active === 'stats' || active === 'settings') ? 'mine' : active;
    var html = '<div class="tabbar">' + tabs.map(function (t) {
      return '<button class="tab ' + (t.id === on ? 'on' : '') + '" data-act="goto" data-to="' + t.id + '">' +
             '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
             'stroke-linecap="round" stroke-linejoin="round">' + ICON[t.id] + '</svg>' +
             t.label + '</button>';
    }).join('') + '</div>';
    app.insertAdjacentHTML('beforeend', html);
  }

  /* ---------------------------------------------------------------------
   * 主渲染
   * ------------------------------------------------------------------- */

  function render() {
    /* 主题要在"没有档案"的分支之前应用，否则第一次打开问卷时还是默认色 */
    applyTheme();
    if (!state.profile) { app.className = ''; renderOnboarding(); return; }
    var rtk = todayKey();
    var rstage = (state.days[rtk] || {}).stage || 'base';
    rebuildCourseLabels();
    var s = state.ui.screen || 'today';
    /* 老数据里可能是 'record'（记录以前是单独一格），归到「我的」 */
    if (s === 'record') { s = 'mine'; state.ui.screen = 'mine'; }
    /* 只在换页时播进入动画。勾个任务就重播一遍的话，看着像闪屏。 */
    var enterKey = s + '|' + rtk;
    var entering = enterKey !== lastEnterKey;
    lastEnterKey = enterKey;
    app.className = 'stage-' + rstage + (entering ? ' entering' : '');
    if (entering) {
      setTimeout(function () { app.classList.remove('entering'); }, 700);
    }
    var out;
    if (s === 'plan') out = renderPlan();
    else if (s === 'tools') out = renderTools();
    else if (s === 'mine') out = renderMine();
    else if (s === 'stats') out = renderStats();
    else if (s === 'settings') out = renderSettings();
    else out = renderToday();

    /* 体验模式：不在今日页时挂一个小标，提醒"你现在看的是模拟日期" */
    if (demoOn()) window.YT.demo.decorate();

    /* 断更回来自动弹出学习档案。等这一屏画完再弹，不然会被后面的渲染盖掉。 */
    if (pendingRestart) {
      var pr = pendingRestart;
      pendingRestart = null;
      openArchive('restart', pr);
    }
    return out;
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
      draft.examTouched = true;
      return reRender();
    }
    if (act === 'pick-base') {
      draft.base = el.getAttribute('data-v');
      applyBaseToUnits();
      return reRender();
    }
    if (act === 'pick-wd') { draft.weekdayMinutes = Number(el.getAttribute('data-v')); return reRender(); }
    if (act === 'pick-we') { draft.weekendMinutes = Number(el.getAttribute('data-v')); return reRender(); }
    if (act === 'pick-mode') { draft.mode = el.getAttribute('data-v'); return reRender(); }
    if (act === 'toggle-rest') {
      var v = Number(el.getAttribute('data-v'));
      var i = draft.restDays.indexOf(v);
      if (i === -1) draft.restDays.push(v); else draft.restDays.splice(i, 1);
      return reRender();
    }
    /* 不需要听课的人：把课节数全部归零，时间全给刷题 */
    if (act === 'no-course') {
      MODULES.forEach(function (m) { draft.courseUnits[m.id] = 0; });
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
    /* 统计、设置左上角的返回 */
    if (act === 'back') return go('mine');
    if (act === 'fold-toggle') {
      var fk = el.getAttribute('data-k');
      state.ui.folds = state.ui.folds || {};
      state.ui.folds[fk] = !foldOpen(fk, false);
      save();
      return reRenderKeepPlace();
    }

    /* ---- 打卡 ---- */
    if (act === 'cycle') {
      var dk = el.getAttribute('data-date');
      var tid = el.getAttribute('data-task');
      var day = state.days[dk];
      if (!day) return;
      var task = (day.tasks || []).filter(function (t) { return t.id === tid; })[0];
      if (!task) return;
      var next = task.status === 'todo' ? 'done' : task.status === 'done' ? 'half' : 'todo';
      /* 跳过之后又做了：跳过自动撤销 */
      if (next !== 'todo' && task.skip) { task.skip = false; delete task.skipAt; }
      setTaskStatus(task, next);
      if (next !== 'done') task.actualMinutes = null;
      /* 听课可以只完成一半：剩下那半节拆成"续听"，下次优先接上。 */
      if (task.kind === 'course') {
        syncHalfCourse(day, task);
        if (next === 'half') toast('已记一半，剩下的会排在下次学习日最前面');
      }
      save();
      return reRender();
    }
    if (act === 'set-actual') {
      var dk2 = el.getAttribute('data-date'), tid2 = el.getAttribute('data-task');
      var t2 = ((state.days[dk2] || {}).tasks || []).filter(function (t) { return t.id === tid2; })[0];
      if (!t2) return;
      t2.actualMinutes = Number(el.getAttribute('data-min'));
      setTaskStatus(t2, t2.status, { actualMinutes: t2.actualMinutes });
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

    /* ---- 自己加任务 ---- */
    if (act === 'del-task') {
      var ddk = el.getAttribute('data-date');
      var dtid = el.getAttribute('data-task');
      var dday = state.days[ddk];
      if (!dday) return;
      var di = -1;
      (dday.tasks || []).forEach(function (t, i) { if (t.id === dtid) di = i; });
      if (di < 0) return;
      var removed = dday.tasks[di];
      /* 删之前问一句，避免误触 */
      return askConfirm('删掉这一项？',
        '「' + removed.title + '」' +
        (removed.continuation ? '——原课程只算完成一半。'
          : removed.kind === 'course' ? '——这节课会顺延到后面。'
          : '——不影响后面的安排。'),
        function () {
          var before = takeSnapshot();
          var dd2 = state.days[ddk];
          if (!dd2) return;
          if (removed.continuation) {
            /* 续听只是一条补课，删掉它不等于把整节课删掉。 */
            dd2.tasks = dd2.tasks.filter(function (t) { return t.id !== dtid; });
            finishChange(before, '已删除「' + removed.title + '」');
          } else if (removed.kind === 'course') {
            /* 同一天同一模块的课全一起去掉，不然"下半节"会挂在上半节没了的情况下 */
            dd2.tasks = dd2.tasks.filter(function (t) {
              return !(t.kind === 'course' && t.moduleId === removed.moduleId);
            });
            Object.keys(state.days).forEach(function (k) {
              if (k <= ddk) return;
              var dd = state.days[k];
              var touched = E.dayTouched(dd);
              if (!touched) delete state.days[k];
            });
            E.ensureAhead(state, todayKey(), 14);
            finishChange(before, '已删除「' + removed.title + '」，后面的课顺延');
          } else {
            dd2.tasks = dd2.tasks.filter(function (t) { return t.id !== dtid; });
            finishChange(before, '已删除「' + removed.title + '」');
          }
        });
    }
    if (act === 'extra-open') {
      state.ui.addingExtra = true;
      state.ui.extraDate = tk;
      extraDraft = { group: null, moduleId: null, type: 'practice' };
      return reRender();
    }
    if (act === 'extra-open-day') {
      var od = el.getAttribute('data-v');
      /* 再点一次同一个"＋"就收起来 */
      if (state.ui.addingExtra && state.ui.extraDate === od) {
        state.ui.addingExtra = false;
        return reRender();
      }
      state.ui.addingExtra = true;
      state.ui.extraDate = od;
      extraDraft = { group: null, moduleId: null, type: 'practice' };
      return reRender();
    }
    if (act === 'extra-cancel') {
      state.ui.addingExtra = false;
      state.ui.extraDate = null;
      return reRender();
    }
    if (act === 'extra-group') {
      var eg = el.getAttribute('data-v');
      extraDraft.group = eg;
      var hit = EXTRA_GROUPS.filter(function (x) { return x.id === eg; })[0];
      /* 没有子模块的板块直接锁定模块 */
      extraDraft.moduleId = (hit && hit.subs) ? null : eg;
      return reRender();
    }
    if (act === 'extra-module') {
      extraDraft.moduleId = el.getAttribute('data-v');
      return reRender();
    }
    if (act === 'extra-type') {
      extraDraft.type = el.getAttribute('data-v');
      return reRender();
    }
    /* 提醒里那个"加一组"，直接开表单并锁定模块 */
    if (act === 'makeup') {
      var mupId = el.getAttribute('data-m');
      var mupMod = MODULE_BY_ID[mupId];
      var mupNeed = E.targetUnits(mupMod, state.profile);
      var mupDone = Math.min(mupNeed, E.courseProgress(state)[mupId] || 0);
      return askInput('补记已听的课',
        mupMod.name + ' 总共 ' + mupNeed + ' 节，现在已经听了多少节？' +
        '（现在记的是 ' + mupDone + ' 节）',
        mupDone,
        function (v) {
          if (v === null || isNaN(v)) return;
          var want = Math.max(0, Math.min(mupNeed, Math.round(v * 2) / 2));
          if (want === mupDone) { toast('没有变化'); return; }
          var before = takeSnapshot();
          if (want > mupDone) markCourseDone(mupId, want - mupDone, todayKey());
          else markCourseUndo(mupId, mupDone - want);
          /* 补完重排后面没动过的天，课程接着往下排 */
          Object.keys(state.days).forEach(function (k) {
            if (k <= todayKey()) return;
            var dd = state.days[k];
            var touched = E.dayTouched(dd);
            if (!touched) delete state.days[k];
          });
          E.ensureAhead(state, todayKey(), 14);
          finishChange(before, '已把「' + mupMod.short + '」的听课进度改成 ' + want + ' 节');
        });
    }
    if (act === 'extra-quick') {
      var qm = el.getAttribute('data-m');
      state.ui.addingExtra = true;
      state.ui.extraDate = tk;
      extraDraft = { group: qm, moduleId: qm, type: 'practice' };
      window.scrollTo(0, document.body.scrollHeight);
      return reRender();
    }
    if (act === 'extra-add') {
      var targetKey = extraTargetDay();
      var dayX = state.days[targetKey];
      if (!dayX) {
        /* 计划页可能点到了还没排到的日子，先把它补出来 */
        E.ensureAhead(state, tk, 90);
        dayX = state.days[targetKey];
      }
      if (!dayX) return;
      /* 休息日上加了任务，就把它当成学习日 */
      if (dayX.isRest) dayX.isRest = false;
      var task = null;
      if (extraDraft.group === 'slw' && extraDraft.type === 'course') {
        var effS2 = window.YT.engine.effectiveLesson(state.profile);
        var qe2 = document.querySelector('[data-act="extra-qty"]');
        var su = Math.max(0.5, Math.round((Number(qe2 && qe2.value) || 1) * 2) / 2);
        task = {
          id: uid('extra-'),
          moduleId: 'slw', moduleName: '申论', kind: 'course',
          title: '申论 · 听课（自己加的）',
          detail: su + ' 节',
          amounts: su, units: su,
          amountText: su + ' 节',
          minutes: Math.round(su * effS2),
          status: 'todo', actualMinutes: null, userAdded: true,
        };
      } else if (extraDraft.group === 'slw') {
        var big = extraDraft.type === 'big';
        task = {
          id: uid('extra-'),
          moduleId: 'slw', moduleName: '申论', kind: 'essay',
          title: '申论 · ' + (big ? '大作文' : '小题'),
          detail: '自己加的',
          amounts: 1,
          amountText: big ? '1 篇' : '1 道',
          minutes: big ? window.YT.ESSAY.bigMinutes : window.YT.ESSAY.smallMinutes,
          status: 'todo', actualMinutes: null, userAdded: true,
        };
      } else if (extraDraft.moduleId) {
        var m3 = MODULE_BY_ID[extraDraft.moduleId];
        var qtyEl = document.querySelector('[data-act="extra-qty"]');
        var qv = qtyEl ? Number(qtyEl.value) : 1;
        if (!qv || qv <= 0) qv = 1;

        if (extraDraft.type === 'course') {
          var eff2 = window.YT.engine.effectiveLesson(state.profile);
          var units = Math.round(qv * 2) / 2;
          task = {
            id: uid('extra-'),
            moduleId: m3.id, moduleName: m3.name, kind: 'course',
            title: m3.short + ' · 听课（自己加的）',
            detail: units + ' 节',
            amounts: units, units: units,
            amountText: units + ' 节',
            minutes: Math.round(units * eff2),
            status: 'todo', actualMinutes: null, userAdded: true,
          };
        } else {
          var per3 = window.YT.unitMinutesFor(m3, dayX.stage, state.profile);
          var q3 = Math.max(1, Math.round((m3.setSize || 20) * qv));
          task = {
            id: uid('extra-'),
            moduleId: m3.id, moduleName: m3.name, kind: 'practice',
            title: m3.short + ' · 加练',
            detail: q3 + ' 题 · 自己加的',
            amount: q3, sets: qv,
            amountText: q3 + ' 题',
            minutes: Math.round(q3 * per3),
            status: 'todo', actualMinutes: null, userAdded: true,
          };
        }
      }
      /* 加不成功要说清楚原因，不能静默返回 */
      if (!task) {
        if (!extraDraft.group) return toast('先选一个科目');
        if (extraDraft.group === 'pd' && !extraDraft.moduleId) return toast('判断推理要再选具体哪一块');
        return toast('这项加不进去，换个科目试试');
      }
      dayX.tasks.push(task);
      state.ui.addingExtra = false;
      state.ui.extraDate = null;
      extraDraft = { group: null, moduleId: null, type: 'practice' };
      save();
      toast('加进去了。这个不算在系统完成率里');
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

    /* ---- 我的记录 ---- */
    if (act === 'rec-pick') {
      var rk = el.getAttribute('data-v');
      state.ui.recDay = state.ui.recDay === rk ? null : rk;
      save();
      return reRender();
    }
    if (act === 'rec-month') {
      var md = Number(el.getAttribute('data-v'));
      var nk = shiftMonth(recMonthKey(tk), md);
      if (nk.slice(0, 7) > tk.slice(0, 7)) return;
      state.ui.recMonth = nk;
      state.ui.recDay = null;
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
      state.profile.moduleParams = {};
      save();
      toast('已恢复推荐值');
      return reRender();
    }
    if (act === 'no-course-settings') {
      return askConfirm('不听课', '所有模块的课节数会设为 0，时间全部给刷题。已经打过的卡不变。', function () {
        var before = takeSnapshot();
        MODULES.forEach(function (m) { state.profile.courseUnits[m.id] = 0; });
        Object.keys(state.days).forEach(function (k) {
          if (k <= todayKey()) return;
          var dd = state.days[k];
          var touched = E.dayTouched(dd);
          if (!touched) delete state.days[k];
        });
        E.ensureAhead(state, todayKey(), 14);
        finishChange(before, '已改成不听课');
      });
    }
    if (act === 'set-essay-start') {
      state.profile.tuning = state.profile.tuning || {};
      state.profile.tuning.essayStartStage = el.getAttribute('data-v');
      save();
      reRender();
      return scheduleRegen(0);
    }

    /* 换主题色。不重排计划也不动数据，只是把 html[data-theme] 换掉。 */
    if (act === 'set-theme') {
      var tid = el.getAttribute('data-v');
      var themeList = (window.YT && window.YT.THEMES) || [];
      var ok = themeList.some(function (t) { return t.id === tid; });
      if (!ok) return;
      state.profile.theme = tid;
      save();
      /* 先把色换掉再重画，点下去是立刻变色，不用等重画完 */
      applyTheme();
      return reRenderKeepPlace();
    }

    /* ---- 设置 ---- */
    if (act === 'set-rest') {
      var rv = Number(el.getAttribute('data-v'));
      var idx = state.profile.restDays.indexOf(rv);
      if (idx === -1) state.profile.restDays.push(rv);
      else state.profile.restDays.splice(idx, 1);
      state.profile.restDays.sort();
      save();
      reRender();
      return scheduleRegen(0);
    }
    if (act === 'set-strength') {
      state.profile.strength[el.getAttribute('data-m')] = el.getAttribute('data-v');
      save();
      reRender();
      return scheduleRegen(0);
    }
    if (act === 'clear-boost') {
      var cbMid = el.getAttribute('data-m');
      if (state.profile.practiceBoost) delete state.profile.practiceBoost[cbMid];
      save();
      reRender();
      return scheduleRegen(0);
    }
    if (act === 'set-mode') {
      state.profile.mode = el.getAttribute('data-v');
      save();
      /* 换模式等于换一套排法，立刻重排 */
      reRender();
      var modeName = { auto: '全自动', semi: '半自动', manual: '自己排' }[state.profile.mode] || '';
      return scheduleRegen(0, '已切到' + modeName + '，后面的安排重排好了');
    }
    if (act === 'phase-reset') {
      state.profile.phasePlan = { custom: false };
      save();
      reRender();
      return scheduleRegen(0, '已恢复系统推荐的阶段安排');
    }
    if (act === 'phase-open') {
      state.ui.screen = 'settings';
      state.ui.folds = state.ui.folds || {};
      state.ui.folds['settings:phase'] = true;
      save();
      render();
      var ph = document.getElementById('phase-plan');
      if (ph && ph.scrollIntoView) ph.scrollIntoView({ block: 'start' });
      return;
    }
    /* 上移/下移一科：顺序即刻生效，后面没动过的天立刻重排 */
    if (act === 'ord-up' || act === 'ord-down') {
      var oid = el.getAttribute('data-m');
      var arr = E.moduleOrder(state.profile).slice();
      var oi = arr.indexOf(oid);
      var oj = act === 'ord-up' ? oi - 1 : oi + 1;
      if (oi < 0 || oj < 0 || oj >= arr.length) return;
      var tmpId = arr[oi]; arr[oi] = arr[oj]; arr[oj] = tmpId;
      state.profile.moduleOrder = arr;
      save();
      return scheduleRegen(0);
    }
    /* 砍课：把每科的课节数按同一个比例缩小，然后重排。
     * 只动听课，一道题都不动——刷题是提分主力。 */
    if (act === 'cut-course') {
      var beforeCut = takeSnapshot();
      var snapCut = planSnapshot();
      var cf = Number(el.getAttribute('data-f')) || 0.6;
      var p0 = state.profile;
      var changed = 0;
      MODULES.forEach(function (m) {
        if (m.essay) return;   // 申论不跟行测一起砍
        var v = (p0.courseUnits && p0.courseUnits[m.id] !== undefined && p0.courseUnits[m.id] !== '')
          ? p0.courseUnits[m.id] : m.courseUnits;
        var nv = Math.max(0.5, Math.round(Number(v) * cf * 2) / 2);
        if (nv < Number(v)) changed++;
        p0.courseUnits[m.id] = nv;
      });
      save();
      generateWithOverlay(function () {
        go('plan');
        finishChange(beforeCut, '课已经砍完', ['把 ' + changed + ' 个模块的课砍到约 ' +
          Math.round(cf * 100) + '%，题一道没动。'].concat(planDiff(snapCut)));
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
      return askConfirm('重新开始？',
        '计划、打卡记录和统计都会删掉，然后回到问卷第一页。想留个底请先导出数据。确定吗？', function () {
        state = store.reset();
        draft = null;
        save();
        render();
      });
    }

    /* ---- 弹窗 ---- */
    if (act === 'chg-undo') {
      if (!lastUndo) return closeModal();
      state.days = lastUndo.days;
      state.weeklyLog = lastUndo.weeklyLog;
      state.weekMark = lastUndo.weekMark;
      if (lastUndo.courseUnits && state.profile) state.profile.courseUnits = lastUndo.courseUnits;
      if (lastUndo.lessonMinutes !== undefined && state.profile) state.profile.lessonMinutes = lastUndo.lessonMinutes;
      if (lastUndo.speed !== undefined && state.profile) state.profile.speed = lastUndo.speed;
      if (lastUndo.adjustId) {
        state.adjustLog = (state.adjustLog || []).filter(function (e) {
          return e.id !== lastUndo.adjustId;
        });
      }
      lastUndo = null;
      save();
      closeModal();
      render();
      toast('已撤销');
      return;
    }
    if (act === 'chg-ok') { lastUndo = null; return closeModal(); }
    if (act === 'adj-open') return openAdjustLog();
    if (act === 'adj-close') return closeModal();
    if (act === 'install-open') return openInstallHelp();
    if (act === 'install-close') return closeModal();
    if (act === 'install-dismiss') {
      state.ui.installHintDismissed = true;
      save();
      closeModal();
      render();
      toast('已关掉这个入口');
      return;
    }
    if (act === 'install-restore') {
      state.ui.installHintDismissed = false;
      save();
      reRenderKeepPlace();
      toast('入口已恢复');
      return;
    }
    if (act === 'install-do') {
      if (!deferredInstallPrompt) return;
      var installEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      installEvent.prompt();
      if (installEvent.userChoice && installEvent.userChoice.then) {
        installEvent.userChoice.then(function (choice) {
          if (choice && choice.outcome === 'accepted') toast('已经添加到桌面');
          else toast('没有添加，也没关系');
          render();
        });
      }
      return;
    }

    /* ---- 成绩记录 ---- */
    if (act === 'score-open') return openScoreForm();
    /* 按建议调整：只动这一科的强度/权重，改完重排 */
    if (act === 'adv-do') {
      var aAct = el.getAttribute('data-a');
      var aMid = el.getAttribute('data-m');
      if (!aMid) return;
      if (aAct === 'set-strong') {
        state.profile.strength[aMid] = 'strong';
      } else if (aAct === 'set-normal') {
        state.profile.strength[aMid] = 'normal';
      } else if (aAct === 'boost') {
        state.profile.practiceBoost = state.profile.practiceBoost || {};
        state.profile.practiceBoost[aMid] = 1.4;
      }
      save();
      generateWithOverlay(function () { toast('已按建议调整，后面的安排重排好了'); });
      return;
    }
    if (act === 'score-cancel') { scoreDraft = null; return closeModal(); }
    if (act === 'score-source') {
      if (!scoreDraft) return;
      scoreDraft.source = el.getAttribute('data-v');
      return renderScoreForm();
    }
    if (act === 'score-save') {
      if (!scoreDraft) return closeModal();
      var rates = {};
      MODULES.forEach(function (m) {
        var v = scoreDraft.rates[m.id];
        if (v !== undefined && v !== null && v !== '') rates[m.id] = v;
      });
      if (!Object.keys(rates).length) return toast('至少填一个模块');
      state.scores = state.scores || [];
      state.scores.push({ date: scoreDraft.date, source: scoreDraft.source, rates: rates });
      if (state.scores.length > 60) state.scores = state.scores.slice(-60);
      /* 错误率变了，复盘时长跟着变，后面没动过的天重排一遍 */
      Object.keys(state.days).forEach(function (k) {
        if (k <= todayKey()) return;
        var dd = state.days[k];
        var touched = E.dayTouched(dd);
        if (!touched) delete state.days[k];
      });
      E.ensureAhead(state, todayKey(), 14);
      scoreDraft = null;
      save();
      closeModal();
      render();
      toast('已记录。复盘时长会按你的错误率算');
      return;
    }

    if (act === 'ask-yes') {
      var icb = inputCb;
      var iel = document.getElementById('ask-input');
      var ival = iel ? Number(iel.value) : null;
      closeAsk();
      if (icb) icb(ival);
      return;
    }
    if (act === 'ask-no') return closeAsk();

    /* ---- 学习档案 ---- */
    if (act === 'arch-open') return openArchive('view');
    if (act === 'round-open') {
      var rid = el.getAttribute('data-v');
      var rr = (state.rounds || []).filter(function (x) { return x.id === rid; })[0];
      if (rr) openArchive('round', null, rr);
      return;
    }
    if (act === 'arch-close') { archDraft = null; return closeModal(); }

    /* ---- 换一场考试 ---- */
    if (act === 'switch-open') return openSwitchExam();
    if (act === 'switch-cancel') { switchDraft = null; return closeModal(); }
    if (act === 'switch-mode') {
      if (!switchDraft) return;
      switchDraft.mode = el.getAttribute('data-v');
      return renderSwitchExam();
    }
    if (act === 'switch-confirm') {
      if (!switchDraft) return closeModal();
      var mode0 = switchDraft.mode;
      if (!applySwitch()) return;
      switchDraft = null;
      closeModal();
      go('today');
      toast(mode0 === 'new' ? '新一轮开始了，上一轮存在学习档案里' : '考试日期已更新，后面重排好了');
      return;
    }

    /* ---- 今天主攻一科 ---- */
    if (act === 'focus-open') return openFocus();

    /* ---- 自己排模式：复盘建议，加不加他说了算 ---- */
    /* ---- 批量排 ---- */
    if (act === 'batch-open') return openBatch();
    if (act === 'batch-cancel') { batchDraft = null; return closeModal(); }
    if (act === 'batch-group') {
      if (!batchDraft) return;
      batchDraft.group = el.getAttribute('data-v');
      batchDraft.moduleId = null;
      return renderBatch();
    }
    if (act === 'batch-module') {
      if (!batchDraft) return;
      batchDraft.moduleId = el.getAttribute('data-v');
      return renderBatch();
    }
    if (act === 'batch-essay') {
      if (!batchDraft) return;
      batchDraft.essayBig = el.getAttribute('data-v') === 'big';
      return renderBatch();
    }
    if (act === 'batch-wd') {
      if (!batchDraft) return;
      var bw = Number(el.getAttribute('data-v'));
      var bi = batchDraft.weekdays.indexOf(bw);
      if (bi === -1) batchDraft.weekdays.push(bw); else batchDraft.weekdays.splice(bi, 1);
      return renderBatch();
    }
    if (act === 'batch-ok') {
      if (!batchDraft) return closeModal();
      if (!batchDraft.group) return toast('先选一个科目');
      if (batchDraft.group === 'pd' && !batchDraft.moduleId) return toast('判断推理要再选具体哪一块');
      if (!batchDraft.weekdays.length) return toast('至少选一天');
      var bres = applyBatch();
      batchDraft = null;
      closeModal();
      if (!bres || !bres.made) { reRender(); return toast('这几天里没有可排的日子'); }
      save();
      render();
      toast('排了 ' + bres.made + ' 条' + (bres.over ? '，其中 ' + bres.over + ' 天超过了每天可用时间' : ''));
      return;
    }

    if (act === 'add-review') {
      var rDay = state.days[tk];
      if (!rDay) return;
      var rMin = Number(el.getAttribute('data-v')) || 30;
      rDay.tasks.push({
        id: uid('review-'),
        moduleId: 'review', moduleName: '复盘', kind: 'review',
        title: '错题复盘',
        detail: '把今天做错的题重做一遍，记下错因',
        minutes: rMin, amountText: rMin + ' 分钟',
        status: 'todo', actualMinutes: null, userAdded: true, review: true,
      });
      save();
      reRender();
      toast('加上了一条 ' + rMin + ' 分钟的复盘');
      return;
    }
    if (act === 'no-review') {
      var nDay = state.days[tk];
      if (nDay) nDay.reviewAsked = 'no';
      save();
      return reRender();
    }

    /* ---- 任务卡的三个动作：今天不做 / 换一科 / 删掉 ---- */
    if (act === 'task-menu') {
      return openTaskMenu(el.getAttribute('data-date'), el.getAttribute('data-task'));
    }
    if (act === 'menu-cancel') { taskMenu = null; return closeModal(); }
    if (act === 'task-skip') {
      if (!taskMenu) return closeModal();
      var skT = findTask(taskMenu.dateKey, taskMenu.taskId);
      if (!skT) { taskMenu = null; return closeModal(); }
      skT.skip = true;
      skT.skipAt = taskMenu.dateKey;
      syncHalfCourse(state.days[taskMenu.dateKey], skT);
      /* 记一笔：连着几天不做同一科，系统要开口问一句 */
      state.skipLog = state.skipLog || [];
      state.skipLog.push({ date: taskMenu.dateKey, moduleId: skT.moduleId });
      if (state.skipLog.length > 60) state.skipLog = state.skipLog.slice(-60);
      taskMenu = null;
      save();
      closeModal();
      reRender();
      toast('今天不做这项，不算你没完成');
      return;
    }
    if (act === 'task-unskip') {
      if (!taskMenu) return closeModal();
      var unT = findTask(taskMenu.dateKey, taskMenu.taskId);
      if (unT) {
        unT.skip = false;
        delete unT.skipAt;
        syncHalfCourse(state.days[taskMenu.dateKey], unT);
        state.skipLog = (state.skipLog || []).filter(function (x) {
          return !(x.date === taskMenu.dateKey && x.moduleId === unT.moduleId);
        });
      }
      taskMenu = null;
      save();
      closeModal();
      reRender();
      return;
    }
    if (act === 'task-swap') return openSwap();
    if (act === 'swap-pick') {
      var newMid = el.getAttribute('data-m');
      var gotMid = applySwap(newMid);
      var swappedName = gotMid ? (MODULE_BY_ID[gotMid] || {}).short : '';
      taskMenu = null;
      closeModal();
      reRender();
      if (gotMid) toast('今天换成' + swappedName + '，后面的安排也会偏一点');
      return;
    }

    if (act === 'focus-cancel') { focusDraft = null; return closeModal(); }
    if (act === 'focus-pick') {
      var fmid = el.getAttribute('data-m');
      var fname = (MODULE_BY_ID[fmid] || {}).short || '';
      var nMade = applyFocus(fmid);
      focusDraft = null;
      save();
      closeModal();
      reRender();
      toast(nMade > 0 ? '今天主攻' + fname + '，其他任务先让位' : '今天剩下的时间不够了');
      return;
    }

    /* ---- 偏好层 ---- */
    if (act === 'pref-yes') {
      var pmid = el.getAttribute('data-m');
      var pm = MODULE_BY_ID[pmid] || {};
      state.profile.practiceBoost = state.profile.practiceBoost || {};
      var curB = state.profile.practiceBoost[pmid] || 1;
      state.profile.practiceBoost[pmid] = Math.round(Math.min(2, curB + 0.4) * 10) / 10;
      state.ui.prefAsked = state.ui.prefAsked || {};
      state.ui.prefAsked[pmid] = true;
      /* 后面还没动过的天重排，让新的权重马上生效 */
      Object.keys(state.days).forEach(function (k) {
        if (k <= tk) return;
        var dd = state.days[k];
        var touched = E.dayTouched(dd);
        if (!touched) delete state.days[k];
      });
      E.ensureAhead(state, tk, 14);
      save();
      reRender();
      toast('已经把' + (pm.short || '') + '排进日常，后面会自动多排它的题');
      return;
    }
    if (act === 'pref-no') {
      state.ui.prefAsked = state.ui.prefAsked || {};
      state.ui.prefAsked[el.getAttribute('data-m')] = true;
      save();
      return reRender();
    }
    /* "今天不做"攒够了 → 直接调成减少（等于替用户去设置里改了那一步） */
    if (act === 'reduce-yes') {
      var rmid = el.getAttribute('data-m');
      state.profile.strength[rmid] = 'light';
      state.ui.prefAsked = state.ui.prefAsked || {};
      state.ui.prefAsked['skip:' + rmid] = true;
      save();
      generateWithOverlay(function () {
        toast('已把' + ((MODULE_BY_ID[rmid] || {}).short || '') + '调成「减少」，后面的安排重排好了');
      });
      return;
    }
    if (act === 'reduce-no') {
      state.ui.prefAsked = state.ui.prefAsked || {};
      state.ui.prefAsked['skip:' + el.getAttribute('data-m')] = true;
      save();
      return reRender();
    }
    if (act === 'arch-toggle') {
      if (!archDraft) return;
      var ai = Number(el.getAttribute('data-i'));
      if (archDraft.items[ai]) archDraft.items[ai].on = !archDraft.items[ai].on;
      return renderArchive();
    }
    if (act === 'arch-more') {
      if (!archDraft) return;
      archDraft.showAll = !archDraft.showAll;
      return renderArchive();
    }
    if (act === 'arch-yes') {
      if (!archDraft) return closeModal();
      var nAdded = addReviewTasks();
      archDraft = null;
      /* 今天是休息日：不硬把他从休息日里拽起来 */
      if (nAdded < 0) { closeModal(); return toast('今天是休息日，先歇着，明天再按这个来'); }
      save();
      closeModal();
      go('today');
      toast(nAdded ? '加到今天了，这些不算在完成率里' : '今天已经有这些了');
      return;
    }

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
    /* 设置页的输入框改完就自动重排。放到 setTimeout 里是因为这里刚读完 el.value，
     * profile 还没更新；等这次处理跑完再看。延迟由 scheduleRegen 自己兜（防抖）。 */
    setTimeout(function () { scheduleRegen(); }, 0);

    if (act === 'set-units') {
      var mid = el.getAttribute('data-m');
      var val = el.value === '' ? '' : Number(el.value);
      if (state.profile) {
        state.profile.courseUnits[mid] = val;
        save();
        /* 旁边那行"已听 X · 剩 Y"立刻跟着变。
         * 不更新的话，用户改完数字看到旁边纹丝不动，会以为没存进去。
         * （整页重画由 scheduleRegen 那边做，这里先给个即时反馈。） */
        var live = el.parentNode && el.parentNode.querySelector
          ? el.parentNode.querySelector('.unit-live') : null;
        if (live) {
          var mm = MODULE_BY_ID[mid];
          var need2 = E.targetUnits(mm, state.profile);
          var done2 = Math.min(need2, E.courseProgress(state)[mid] || 0);
          live.textContent = need2 > 0 ? ('已听 ' + done2 + ' · 剩 ' + (need2 - done2)) : '';
        }
      }
      else if (draft) {
        draft.courseUnits[mid] = val;
        /* 不整页重渲染（会丢焦点），只把下面那块预览换掉 */
        refreshObPreview();
      }
      return;
    }
    /* 问卷里的考试日期。手输日期时"下一步"要立刻可用——
     * 之前这个输入框漏了 data-act，手输的日期系统根本收不到，
     * 只有下面几个快捷按钮能用。 */
    if (act === 'set-exam-draft') {
      draft.examDate = el.value;
      var nb = document.querySelector('[data-act="ob-next"]');
      if (nb) {
        if (draft.examDate) { nb.style.opacity = ''; nb.style.pointerEvents = ''; }
        else { nb.style.opacity = '.4'; nb.style.pointerEvents = 'none'; }
      }
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
    if (act === 'set-module') {
      var mm = el.getAttribute('data-m');
      var mk = el.getAttribute('data-k');
      var mscale = Number(el.getAttribute('data-scale') || 1);
      state.profile.moduleParams = state.profile.moduleParams || {};
      state.profile.moduleParams[mm] = state.profile.moduleParams[mm] || {};
      if (el.value === '') {
        delete state.profile.moduleParams[mm][mk];
      } else {
        var mv = Number(el.value) / mscale;
        if (!isNaN(mv)) state.profile.moduleParams[mm][mk] = mv;
      }
      save();
      return;
    }
    /* 改组数/节数时实时更新"约多少分钟" */
    if (act === 'extra-qty') {
      var qper = Number(el.getAttribute('data-per')) || 0;
      var qsize = Number(el.getAttribute('data-size')) || 1;
      var qv2 = Number(el.value) || 0;
      var mn2 = document.getElementById('ef-min');
      if (mn2) mn2.textContent = Math.round(qper * qsize * qv2);
      return;
    }
    if (act === 'score-rate') {
      if (!scoreDraft) return;
      var sm = el.getAttribute('data-m');
      scoreDraft.rates[sm] = el.value === '' ? '' : Math.max(0, Math.min(1, Number(el.value) / 100));
      return;
    }
    if (act === 'score-date') {
      if (scoreDraft) scoreDraft.date = el.value;
      return;
    }
    if (act === 'set-lesson') {
      if (draft) { draft.lessonMinutes = Number(el.value); refreshObPreview(); }
      else { state.profile.lessonMinutes = Number(el.value); save(); }
      return;
    }
    if (act === 'set-speed') {
      var v = Math.max(1, Math.min(3, Number(el.value) || 1));
      if (draft) { draft.speed = v; refreshObPreview(); }
      else { state.profile.speed = v; save(); }
      return;
    }
    /* 阶段安排：只让用户改两个日期。校验不通过就把输入框退回上一个有效值。 */
    if (act === 'set-base-end' || act === 'set-sprint-start') {
      var phase = state.profile.phasePlan = state.profile.phasePlan || {};
      var prm = state.roadmap || E.buildRoadmap(state.profile, todayKey());
      var pRec = prm.phasePlan || {};
      var curBase = (phase.baseEnd) || pRec.baseEnd || '';
      var curSprint = (phase.sprintStart) || pRec.sprintStart || '';
      var otherDate = act === 'set-base-end' ? curSprint : curBase;
      var nv = el.value;
      var revert = function (msg) {
        toast(msg);
        el.value = act === 'set-base-end' ? curBase : curSprint;
      };
      if (!nv) return revert('日期不能为空');
      if (nv < todayKey()) return revert('日期不能早于今天');
      if (act === 'set-base-end' && otherDate && nv >= otherDate) {
        return revert('基础期结束要早于冲刺期开始');
      }
      if (act === 'set-base-end' && state.profile.examDate && nv >= state.profile.examDate) {
        return revert('基础期结束要早于考试日');
      }
      if (act === 'set-sprint-start' && otherDate && nv <= otherDate) {
        return revert('冲刺期开始要晚于基础期结束');
      }
      if (act === 'set-sprint-start' && state.profile.examDate && nv > state.profile.examDate) {
        return revert('冲刺期开始不能晚于考试日');
      }
      phase.custom = true;
      if (act === 'set-base-end') phase.baseEnd = nv;
      else phase.sprintStart = nv;
      if (!phase.baseEnd) phase.baseEnd = curBase;
      if (!phase.sprintStart) phase.sprintStart = curSprint;
      save();
      return;
    }
    if (act === 'set-exam') {
      state.profile.examDate = el.value;
      state.profile.phasePlan = { custom: false };
      save();
      return;
    }
    if (act === 'set-wd') { state.profile.weekdayMinutes = Number(el.value); save(); return; }
    if (act === 'set-we') { state.profile.weekendMinutes = Number(el.value); save(); return; }
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'set-exam') {
      state.profile.examDate = el.value;
      state.profile.phasePlan = { custom: false };
      save();
    }
    if (act === 'switch-date' && switchDraft) { switchDraft.examDate = el.value; }
    if (act === 'switch-name' && switchDraft) { switchDraft.name = el.value; }
    if (act === 'switch-wd' && switchDraft) { switchDraft.weekdayMinutes = Number(el.value); }
    if (act === 'switch-we' && switchDraft) { switchDraft.weekendMinutes = Number(el.value); }
    if (act === 'batch-num' && batchDraft) {
      var bk = el.getAttribute('data-k');
      batchDraft[bk] = Number(el.value) || 1;
      return renderBatch();          // 重画一次，好让"会排到哪天"跟着变
    }
    /* 自己填的实际用时：输入完按回车或者点到别处就提交 */
    if (act === 'actual-custom') {
      var v = Number(el.value);
      if (!v || v <= 0) return;
      var dk = el.getAttribute('data-date');
      var tid = el.getAttribute('data-task');
      var t = ((state.days[dk] || {}).tasks || []).filter(function (x) { return x.id === tid; })[0];
      if (!t) return;
      t.actualMinutes = Math.max(1, Math.min(600, Math.round(v)));
      setTaskStatus(t, t.status, { actualMinutes: t.actualMinutes });
      save();
      render();
    }
  });

  /* ---------------------------------------------------------------------
   * 启动
   * ------------------------------------------------------------------- */

  function boot() {
    if (state.profile) {
      /* 计划它是一份"算出来的"数据。用回原来的起点重建一遍，
       * 免得配置文件改了之后，存下来的这份还是旧的、字段对不上。 */
      var start = (state.roadmap && state.roadmap.startKey) || todayKey();
      state.roadmap = E.buildRoadmap(state.profile, start);
      lastRollKey = todayKey();
      dailyRoll();
      save();
    }
    render();
  }

  /* 手机从后台切回来时页面不会重新加载，跨天也不会自己重算。
   * 所以每次回到前台，如果已经不是同一天了，就补跑一次跨天检查
   * （断更、顺延、重新排两周走的都是真实路径）。 */
  var lastRollKey = null;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!state.profile) return;
    var tk = todayKey();
    if (tk === lastRollKey) return;
    lastRollKey = tk;
    dailyRoll();
    save();
    render();
  });

  /* 调试用：在浏览器控制台里输入 __ytDebug() 就能看到当前状态 */
  window.__ytDebug = function () { return state; };

  /* 安卓 / Chrome 的"添加到桌面"事件。iOS 没有这个事件，
   * 走 openInstallHelp() 里的 Safari 步骤说明。 */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (state.profile && (state.ui.screen || 'today') === 'mine') render();
  });
  window.addEventListener('appinstalled', function () {
    deferredInstallPrompt = null;
    state.ui.installed = true;
    save();
    toast('已经添加到桌面');
    render();
  });

  boot();
})();
