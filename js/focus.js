/* =========================================================================
 * focus.js —— 专注内核（番茄钟 + 正计时）
 *
 * 这一层跟"挂在哪个页面"完全无关：任务卡上的「开始专注」、「工具」tab、
 * 运行中那条常驻细条，三个入口共用同一份计时和同一份记录。
 *
 * 计时用"结束时间戳"算法：把"这一阶段什么时候结束"记成一个绝对时间，
 * 每次只拿 Date.now() 去减。切后台、锁屏、切 tab 回来，剩余时间都是准的，
 * 不依赖 setInterval 的精度（那个在后台会被节流得离谱）。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  var E = YT.engine;

  /* host 由 app.js 注入：内核不直接碰 state / save / render，
   * 这样搬到别的挂载点（或者小程序）时只要换一个 host。 */
  var host = null;
  function attach(h) { host = h || null; }
  function st() { return host ? host.getState() : null; }
  function save() { if (host && host.save) host.save(); }
  function rerender() { if (host && host.render) host.render(); }
  function toast(m) { if (host && host.toast) host.toast(m); }

  /* 运行中的那一颗计时器。只活在内存里——刷新页面就重来。 */
  var live = null;
  /* 刷新/被系统杀掉时没结束的那一颗，从存档里捞出来先放这儿。
   * 超过 4 小时没回来就不替他做主，问一句。 */
  var pendingRestore = null;
  var STALE_MS = 4 * 60 * 60 * 1000;

  var DEFAULT_SETTINGS = { work: 25, short: 5, long: 15, rounds: 4 };

  function settings(state) {
    if (!state.focus || typeof state.focus !== 'object') state.focus = {};
    var s = state.focus.settings;
    if (!s || typeof s !== 'object') s = state.focus.settings = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      var v = Number(s[k]);
      if (!isFinite(v) || v <= 0) s[k] = DEFAULT_SETTINGS[k];
    });
    if (!Array.isArray(state.focus.sessions)) state.focus.sessions = [];
    return s;
  }

  function setSetting(state, key, value) {
    if (DEFAULT_SETTINGS[key] === undefined) return;
    var v = Math.round(Number(value));
    if (!isFinite(v) || v <= 0) return;
    if (key === 'work') v = Math.min(180, Math.max(1, v));
    else if (key === 'rounds') v = Math.min(12, Math.max(1, v));
    else v = Math.min(60, Math.max(1, v));
    settings(state)[key] = v;
  }

  function sessionList(state) {
    if (!state.focus || typeof state.focus !== 'object') state.focus = {};
    if (!Array.isArray(state.focus.sessions)) state.focus.sessions = [];
    return state.focus.sessions;
  }

  function runtime() { return live; }
  function isRunning() { return !!live; }

  /* ---------------------------------------------------------------------
   * 存档与恢复
   *
   * 计时用结束时间戳算，所以只需要把"这一颗计时器"本身存下来，
   * 重开之后剩余时间是自然算对的。只在状态真的变了的时候写一次，
   * 不是每 500ms 写一次。
   * ------------------------------------------------------------------- */

  function persist() {
    var state = st();
    if (!state) return;
    if (!state.focus || typeof state.focus !== 'object') state.focus = {};
    state.focus.live = live ? {
      mode: live.mode, phase: live.phase, running: live.running,
      startedAt: live.startedAt, phaseStartAt: live.phaseStartAt,
      endsAt: live.endsAt === undefined ? null : live.endsAt,
      remainMs: live.remainMs === undefined ? null : live.remainMs,
      elapsedMs: live.elapsedMs || 0, phaseMs: live.phaseMs || 0,
      longBreak: !!live.longBreak,
      workMin: live.workMin, shortMin: live.shortMin, longMin: live.longMin,
      rounds: live.rounds, round: live.round,
      taskId: live.taskId || null, dateKey: live.dateKey || null,
      moduleId: live.moduleId || null, label: live.label || '',
    } : null;
    save();
  }

  /* 启动时捞一次。返回：
   *   null                  —— 没有没结束的计时器
   *   {kind:'resumed'}      —— 已经接着走了（番茄钟继续跑，正计时恢复成暂停）
   *   {kind:'ask', ...}     —— 超时太久，界面问一句用户再决定 */
  function restore(state) {
    var saved = state && state.focus && state.focus.live;
    if (!saved) return null;

    /* 正计时恢复成"暂停"：关掉 App 的那段时间没法算作在学习。
     * 番茄钟不一样，它本来就是按绝对时间跑的，接着走才对。 */
    if (saved.mode === 'countup') {
      live = saved;
      live.running = false;
      live.phaseStartAt = Date.now();
      startLoop();
      return { kind: 'resumed', paused: true };
    }

    if (!saved.running) {          // 暂停中的番茄钟，原样放回来
      live = saved;
      startLoop();
      return { kind: 'resumed', paused: true };
    }

    var now = Date.now();
    if (saved.endsAt && now - saved.endsAt > STALE_MS) {
      pendingRestore = saved;
      return { kind: 'ask', label: labelOf(saved), minutes: Math.round(saved.workMin || 0) };
    }
    live = saved;
    startLoop();
    return { kind: 'resumed' };
  }

  /* 超时那一颗怎么处理：继续 / 按整段记下来 / 丢掉。 */
  function resolveRestore(state, choice) {
    var saved = pendingRestore;
    pendingRestore = null;
    if (!saved) return null;
    if (choice === 'keep') {
      live = saved;
      live.running = true;
      startLoop();
      persist();
      return true;
    }
    if (choice === 'record') {
      if (saved.phase === 'work' && saved.mode !== 'countup') {
        var mins = Math.max(0, Math.round(saved.workMin || 0));
        if (mins > 0) {
          recordSession(state, saved, mins, true, Date.now());
          attributeToTask(state, saved, mins);
        }
      }
    }
    live = null;
    persist();
    return true;
  }

  function hasPendingRestore() { return !!pendingRestore; }

  /* ---------------------------------------------------------------------
   * 计时
   * ------------------------------------------------------------------- */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var total = Math.ceil(ms / 1000);
    var m = Math.floor(total / 60), s = total % 60;
    return (m < 100 ? pad2(m) : '' + m) + ':' + pad2(s);
  }

  /* 当前这段走过了多久（毫秒） */
  function elapsedMs(r, now) {
    if (!r) return 0;
    if (r.running) {
      if (r.mode === 'countup') return r.elapsedMs + (now - r.phaseStartAt);
      return r.phaseMs - Math.max(0, r.endsAt - now);
    }
    if (r.mode === 'countup') return r.elapsedMs;
    return r.phaseMs - Math.max(0, r.remainMs || 0);
  }

  function remainingMs() {
    if (!live) return 0;
    var now = Date.now();
    if (live.mode === 'countup') return elapsedMs(live, now);
    if (live.running) return Math.max(0, live.endsAt - now);
    return Math.max(0, live.remainMs || 0);
  }

  function labelOf(r) {
    if (!r) return '';
    return r.label || (r.mode === 'countup' ? '自由专注' : '专注');
  }

  /* 开始一段新阶段 */
  function beginPhase(r, phase, now, isLong) {
    r.phase = phase;
    r.longBreak = !!isLong;
    r.phaseStartAt = now;
    r.remainMs = null;
    r.running = true;
    if (phase === 'work') {
      r.phaseMs = r.workMin * 60000;
      r.endsAt = now + r.phaseMs;
    } else {
      r.phaseMs = (isLong ? r.longMin : r.shortMin) * 60000;
      r.endsAt = now + r.phaseMs;
    }
  }

  /* 开始专注。opts：
   *   mode      'pomodoro' | 'countup'
   *   taskId / dateKey / moduleId / label   挂到哪个任务（可选）
   */
  function start(state, opts) {
    opts = opts || {};
    var s = settings(state);
    var now = Date.now();
    live = {
      mode: opts.mode === 'countup' ? 'countup' : 'pomodoro',
      phase: 'work',
      running: true,
      startedAt: now,
      phaseStartAt: now,
      elapsedMs: 0,
      workMin: s.work,
      shortMin: s.short,
      longMin: s.long,
      rounds: s.rounds,
      round: 1,
      taskId: opts.taskId || null,
      dateKey: opts.dateKey || null,
      moduleId: opts.moduleId || null,
      label: opts.label || '',
    };
    if (live.mode === 'countup') {
      live.endsAt = null;
      live.phaseMs = 0;
    } else {
      beginPhase(live, 'work', now, false);
    }
    requestNotifyPermission();
    startLoop();
    persist();
    return live;
  }

  function pause() {
    if (!live || !live.running) return false;
    var now = Date.now();
    if (live.mode === 'countup') {
      live.elapsedMs += now - live.phaseStartAt;
    } else {
      live.remainMs = Math.max(0, live.endsAt - now);
    }
    live.running = false;
    persist();
    return true;
  }

  function resume() {
    if (!live || live.running) return false;
    var now = Date.now();
    if (live.mode === 'countup') {
      live.phaseStartAt = now;
    } else {
      live.endsAt = now + Math.max(0, live.remainMs || 0);
    }
    live.running = true;
    persist();
    return true;
  }

  /* 记一条专注记录，并把时长算到挂着的任务头上 */
  function recordSession(state, r, minutes, completed, now) {
    minutes = Math.round(minutes);
    if (minutes <= 0) return null;
    var sess = {
      startedAt: new Date(r.startedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      minutes: minutes,
      mode: r.mode,
      completed: !!completed,
    };
    if (r.taskId) sess.taskId = r.taskId;
    if (r.dateKey) sess.dateKey = r.dateKey;
    if (r.moduleId) sess.moduleId = r.moduleId;
    var list = sessionList(state);
    list.push(sess);
    if (list.length > 600) state.focus.sessions = list.slice(-600);
    return sess;
  }

  function attributeToTask(state, r, minutes) {
    if (!r || !r.taskId || !r.dateKey) return;
    var day = state.days && state.days[r.dateKey];
    if (!day) return;
    var t = (day.tasks || []).filter(function (x) { return x.id === r.taskId; })[0];
    if (!t) return;
    /* 只写"计时器专注"这一层。自报实际用时（actualMinutes）由完成弹窗写，
     * 两者分开存，统计时才不会互相覆盖。 */
    t.focusMinutes = (Number(t.focusMinutes) || 0) + minutes;
  }

  /* 推进一步。返回 {event:'work-done'|'break-done'} 或 null。 */
  function tick(state) {
    if (!live || !live.running || live.mode === 'countup') return null;
    var now = Date.now();
    if (live.endsAt - now > 0) return null;

    if (live.phase === 'work') {
      var mins = Math.max(1, Math.round(live.workMin));
      recordSession(state, live, mins, true, now);
      attributeToTask(state, live, mins);
      live.round++;
      var isLong = (live.round - 1) % live.rounds === 0;
      beginPhase(live, 'break', now, isLong);
      save();
      persist();
      notify(state, 'work', isLong);
      return { event: 'work-done' };
    }
    beginPhase(live, 'work', now, false);
    save();
    persist();
    notify(state, 'break', false);
    return { event: 'break-done' };
  }

  /* 结束这一段专注 */
  function stop(state) {
    if (!live) return null;
    var now = Date.now();
    var r = live;
    var mins = 0;
    /* 休息阶段结束不记专注——那段时间不算"专注"。 */
    if (r.mode === 'countup' || r.phase === 'work') {
      mins = elapsedMs(r, now) / 60000;
      /* 不到 1 分钟的不值得留痕 */
      if (mins >= 1) {
        recordSession(state, r, mins, r.mode === 'countup', now);
        attributeToTask(state, r, Math.round(mins));
      }
    }
    live = null;
    stopLoop();
    save();
    persist();
    return Math.round(mins);
  }

  /* 番茄钟里跳过当前这一段 */
  function skip(state) {
    if (!live || live.mode === 'countup') return false;
    var now = Date.now();
    if (live.phase === 'work') {
      var mins = elapsedMs(live, now) / 60000;
      if (mins >= 1) { recordSession(state, live, mins, false, now); attributeToTask(state, live, Math.round(mins)); }
      live.round++;
      beginPhase(live, 'break', now, (live.round - 1) % live.rounds === 0);
    } else {
      beginPhase(live, 'work', now, false);
    }
    save();
    persist();
    return true;
  }

  /* ---------------------------------------------------------------------
   * 到点提示：提示音 + 振动 + 系统通知（能用的才用）
   * ------------------------------------------------------------------- */

  var audioCtx = null;
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      [0, 0.28].forEach(function (offset) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.value = 0.0001;
        osc.connect(gain); gain.connect(audioCtx.destination);
        var t0 = audioCtx.currentTime + offset;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        osc.start(t0); osc.stop(t0 + 0.26);
      });
    } catch (e) { /* 静音环境就算了 */ }
  }

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  function requestNotifyPermission() {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') Notification.requestPermission();
    } catch (e) {}
  }

  function systemNotify(title, body) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      var n = new Notification(title, { body: body, tag: 'yang-focus' });
      setTimeout(function () { try { n.close(); } catch (e) {} }, 8000);
    } catch (e) {}
  }

  function notify(state, kind, isLong) {
    var task = labelOf(live);
    if (kind === 'work') {
      beep();
      vibrate([220, 90, 220]);
      systemNotify('专注结束', (task ? '「' + task + '」' : '') +
        (isLong ? '该长休息了' : '休息一会儿吧'));
    } else {
      beep();
      vibrate([180, 80, 180]);
      systemNotify('休息结束', '回来接着专注');
    }
  }

  /* ---------------------------------------------------------------------
   * 界面：常驻细条 + 工具页面板
   * ------------------------------------------------------------------- */

  function phaseText() {
    if (!live) return '';
    if (live.mode === 'countup') return live.running ? '正计时中' : '已暂停';
    if (live.phase === 'break') return (live.longBreak ? '长休息' : '休息') + (live.running ? '中' : '（暂停）');
    return '专注' + (live.running ? '中' : '（暂停）') + ' · 第 ' + live.round + ' 个番茄';
  }

  function clockText() {
    if (!live) return '--:--';
    if (live.mode === 'countup') return fmtClock(elapsedMs(live, Date.now()));
    return fmtClock(remainingMs());
  }

  function barHtml() {
    if (!live) return '';
    return '<button class="focus-bar" data-act="goto" data-to="tools" aria-label="回到番茄钟">' +
      '<span class="fb-dot"></span>' +
      '<span class="fb-phase" data-focus="phase">' + esc(phaseText()) + '</span>' +
      '<span class="fb-clock" data-focus="clock">' + clockText() + '</span>' +
      '<span class="fb-label">' + esc(labelOf(live)) + '</span>' +
      '<span class="fb-go">›</span>' +
    '</button>';
  }

  /* 只刷新时间文字，不整页重画——每秒重画一次会把滚动位置弄丢 */
  function paint() {
    var els = document.querySelectorAll('[data-focus="clock"]');
    var text = clockText();
    for (var i = 0; i < els.length; i++) els[i].textContent = text;
    var pe = document.querySelectorAll('[data-focus="phase"]');
    var pt = phaseText();
    for (var j = 0; j < pe.length; j++) pe[j].textContent = pt;
    var lb = document.querySelectorAll('[data-focus="label"]');
    var lt = labelOf(live);
    for (var k = 0; k < lb.length; k++) lb[k].textContent = lt;
  }

  var loop = null;
  function startLoop() {
    if (loop) return;
    loop = setInterval(function () {
      var state = st();
      if (!live) { stopLoop(); return; }
      var res = null;
      if (state) res = tick(state);
      if (res) rerender();
      else paint();
    }, 500);
  }
  function stopLoop() {
    if (loop) { clearInterval(loop); loop = null; }
  }

  /* 工具页里的一屏 */
  function panelHtml(state, tk) {
    var s = settings(state);
    var sessions = sessionList(state);
    /* 这里要的是"今天"，不是"到今天为止"——累计值另有统计页去讲。 */
    var totals = YT.stats.focusToday(state, tk);
    var todaySessions = sessions.filter(function (x) {
      try { return E.toKey(new Date(x.startedAt)) === tk; } catch (e) { return false; }
    });

    if (live) return liveHtml(state, tk);

    var day = state.days && state.days[tk];
    var tasks = (day && day.tasks) || [];
    var options = '<option value="">自由专注（不挂任务）</option>' + tasks.map(function (t) {
      return '<option value="' + esc(t.id) + '"' +
        (state.ui && state.ui.focusTask === t.id ? ' selected' : '') + '>' + esc(t.title) + '</option>';
    }).join('');
    var mode = (state.ui && state.ui.focusMode === 'countup') ? 'countup' : 'pomodoro';
    var foldOpen = !!(state.ui && state.ui.focusFold);

    /* 番茄钟才有可调的时长；正计时就是一个纯计时器，不给参数。
     * 参数默认收起，留一行摘要，点开才展开——工具页要的是"一眼看到开始"。 */
    var settingsBlock;
    if (mode === 'countup') {
      settingsBlock = '<div class="focus-note">正计时：从 0 开始往上计，没有阶段和休息。</div>';
    } else if (!foldOpen) {
      settingsBlock =
        '<button class="focus-fold" data-act="focus-fold">' +
          '<span class="ff-t">时长设置</span>' +
          '<span class="ff-n">专注 ' + s.work + ' · 短休 ' + s.short + ' · 长休 ' + s.long + '</span>' +
          '<span class="ff-chev">›</span>' +
        '</button>';
    } else {
      settingsBlock =
        '<button class="focus-fold open" data-act="focus-fold">' +
          '<span class="ff-t">时长设置</span>' +
          '<span class="ff-n">专注 ' + s.work + ' · 短休 ' + s.short + ' · 长休 ' + s.long + '</span>' +
          '<span class="ff-chev">›</span>' +
        '</button>' +
        '<div class="focus-settings">' +
          '<div class="fs-row"><label>专注</label>' +
            '<input type="number" min="1" max="180" data-act="focus-set" data-k="work" value="' + s.work + '"><span>分钟</span></div>' +
          '<div class="fs-row"><label>短休</label>' +
            '<input type="number" min="1" max="60" data-act="focus-set" data-k="short" value="' + s.short + '"><span>分钟</span></div>' +
          '<div class="fs-row"><label>长休</label>' +
            '<input type="number" min="1" max="60" data-act="focus-set" data-k="long" value="' + s.long + '"><span>分钟</span></div>' +
          '<div class="fs-row"><label>长休间隔</label>' +
            '<input type="number" min="1" max="12" data-act="focus-set" data-k="rounds" value="' + s.rounds + '"><span>个番茄</span></div>' +
        '</div>';
    }

    var todayList = todaySessions.slice().reverse().slice(0, 6).map(function (x) {
      var when = '';
      try { when = pad2(new Date(x.endedAt).getHours()) + ':' + pad2(new Date(x.endedAt).getMinutes()); } catch (e) {}
      return '<div class="fx-row"><span class="fx-t">' + when + '</span>' +
        '<span class="fx-m">' + x.minutes + ' 分钟</span>' +
        '<span class="fx-k">' + (x.mode === 'pomodoro' ? (x.completed ? '番茄' : '未满') : '正计时') + '</span></div>';
    }).join('');

    return '' +
      '<div class="tool-head"><div class="tool-name">番茄钟</div>' +
        '<div class="tool-sub">开始之后可以切到别的页面，计时不会停</div></div>' +

      '<div class="segmented" style="margin-top:12px">' +
        '<button class="' + (mode === 'pomodoro' ? 'on' : '') + '" data-act="focus-mode" data-v="pomodoro">番茄钟</button>' +
        '<button class="' + (mode === 'countup' ? 'on' : '') + '" data-act="focus-mode" data-v="countup">正计时</button>' +
      '</div>' +

      settingsBlock +

      '<div class="focus-pick"><label>挂到今天的任务</label>' +
        '<select class="input" data-act="focus-task">' + options + '</select></div>' +

      '<button class="btn primary block" style="margin-top:12px" data-act="focus-start">开始专注</button>' +

      '<div class="focus-today">今天专注 <b>' + totals.minutes + '</b> 分钟 · ' +
        '<b>' + totals.pomodoros + '</b> 个番茄</div>' +
      (todayList ? '<div class="fx-list">' + todayList + '</div>' : '');
  }

  function liveHtml(state, tk) {
    var big = live.mode === 'countup' ? fmtClock(elapsedMs(live, Date.now())) : fmtClock(remainingMs());
    return '' +
      '<div class="tool-head"><div class="tool-name">番茄钟</div></div>' +
      '<div class="focus-live">' +
        '<div class="focus-phase" data-focus="phase">' + esc(phaseText()) + '</div>' +
        '<div class="focus-clock" data-focus="clock">' + big + '</div>' +
        '<div class="focus-label" data-focus="label">' + esc(labelOf(live)) + '</div>' +
        '<div class="row" style="gap:8px;margin-top:16px">' +
          (live.running
            ? '<button class="btn grow" data-act="focus-pause">暂停</button>'
            : '<button class="btn primary grow" data-act="focus-resume">继续</button>') +
          (live.mode === 'pomodoro'
            ? '<button class="btn grow" data-act="focus-skip">' + (live.phase === 'break' ? '跳过休息' : '跳过这个番茄') + '</button>'
            : '') +
          '<button class="btn grow danger" data-act="focus-stop">结束</button>' +
        '</div>' +
      '</div>' +
      '<div class="footnote">切到别的页面也没关系，这里会一直在走。' +
        (live.taskId && live.dateKey ? '专注结束时长会算到它头上。' : '') + '</div>';
  }

  /* ---------------------------------------------------------------------
   * 注册成工具
   * ------------------------------------------------------------------- */

  YT.registerTool({
    id: 'pomodoro',
    name: '番茄钟',
    icon: '<circle cx="12" cy="13" r="7.4"/><path d="M12 13V9.4M9.4 4.2h5.2"/>',
    /* 挂载点：本轮先只在「自己排」出现。要把它加到半自动的工具栏，
     * 放宽这一行就行，页面那边一个字不用改。 */
    available: function (ctx) { return !!(ctx && ctx.state && YT.engine.isManual(ctx.state.profile)); },
    render: function (ctx) { return panelHtml(ctx.state, ctx.tk); },
  });

  YT.focus = {
    attach: attach,
    settings: settings,
    setSetting: setSetting,
    runtime: runtime,
    isRunning: isRunning,
    restore: restore,
    resolveRestore: resolveRestore,
    hasPendingRestore: hasPendingRestore,
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    skip: skip,
    tick: tick,
    remainingMs: remainingMs,
    clockText: clockText,
    paint: paint,
    barHtml: barHtml,
    panelHtml: panelHtml,
  };
})(window.YT);
