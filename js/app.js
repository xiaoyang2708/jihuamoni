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

  var state = store.load();
  var app = document.getElementById('app');
  var overlay = document.getElementById('overlay');
  var draft = null;
  var lastEnterKey = '';
  var pendingRestart = null;   // 断更回来时，等这一屏画完再弹学习档案

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
   * C1 学习档案
   *
   * 两个入口共用这一套：
   *   view    —— 统计页里点开，随时都能看
   *   restart —— 断更之后自动弹出来，先说"你完成了什么"，再说"从哪接上"
   * 文案只写"怎么办"，不写"系统怎么工作"。
   * ------------------------------------------------------------------- */

  var archDraft = null;

  function barWidth(done, need) {
    if (!need) return 0;
    return Math.max(0, Math.min(100, Math.round(done / need * 100)));
  }

  function openArchive(mode, info) {
    var tk = todayKey();
    var stage = (state.days[tk] || {}).stage || 'base';
    var arch = window.YT.archive.build(state, tk, stage);
    archDraft = {
      mode: mode || 'view',
      info: info || null,
      arch: arch,
      items: (arch.review || []).map(function (r) { return { on: true, item: r }; }),
    };
    renderArchive();
  }

  function renderArchive() {
    if (!archDraft) return;
    var a = archDraft.arch;
    var restart = archDraft.mode === 'restart';

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

    /* ---- 建议先回顾这些 ---- */
    var reviewHtml = archDraft.items.map(function (it, i) {
      return '<button class="arch-item' + (it.on ? ' on' : '') + '" data-act="arch-toggle" data-i="' + i + '">' +
        '<span class="box">' + (it.on ? '✓' : '') + '</span>' +
        '<span class="at"><b>' + esc(it.item.title) + '</b>' +
          '<span class="ad">' + esc(it.item.detail) + ' · ' + fmtMinutes(it.item.minutes) + '</span></span>' +
      '</button>';
    }).join('');

    var head, sub;
    if (restart) {
      head = '先看看你学到哪了';
      sub = a.lastKey
        ? '你上次学习是 ' + fmtDate(a.lastKey, false) + '，到今天 ' + a.gap + ' 天。'
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
        (a.gap >= 8 ? '今天先按六成的量来，接上比补上重要。' : '今天先按八成的量来，找回手感。') + '</div>';
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
              '<div class="arch-h">建议先做这些　<span class="arch-sum">不想做的点掉</span></div>' +
              reviewHtml +
            '</div>'
          : '') +

        '<div class="row" style="gap:10px;margin-top:18px">' +
          (restart ? '<button class="btn grow" data-act="arch-close">先不用</button>' : '') +
          (!restart && reviewHtml ? '<button class="btn grow" data-act="arch-close">知道了</button>' : '') +
          (reviewHtml
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
        id: 'review-' + Date.now() + '-' + added,
        moduleId: r.moduleId,
        moduleName: r.moduleName,
        kind: isCourseReview ? 'review' : 'practice',
        title: r.title,
        detail: r.detail,
        amounts: isCourseReview ? 1 : r.amount,
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
          id: 'makeup-' + Date.now(),
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

  function finishChange(before, title) {
    rebuildCourseLabels();
    var diff = diffDays(before.days, state.days);
    lastUndo = before;
    save();
    render();
    if (!diff.length) { toast(title); return; }
    showChangePanel(title, diff);
  }

  function showChangePanel(title, diff) {
    var shown = diff.slice(0, 4);
    var more = diff.length - shown.length;
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<div class="modal-title">' + esc(title) + '</div>' +
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
   * 开发者工具：快进
   * 不用真的等 30 天，就能看到跨周重排、降档、阶段推进跑出来是什么样。
   * 发布给朋友时把 SHOW_DEV 改成 false，这一块就不出现。
   * ------------------------------------------------------------------- */

  var SHOW_DEV = true;

  function makeRnd(seed) {
    var s = seed || 20260918;
    return function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /* 按完成率造一天的打卡记录。固定种子，同样参数跑出来结果一样。 */
  function simulateCheckin(day, rate, rnd) {
    if (!day || day.isRest) return;
    (day.tasks || []).forEach(function (t) {
      var r = rnd();
      if (r < rate) {
        t.status = 'done';
        if (rnd() < 0.6) {
          t.actualMinutes = Math.max(1, Math.round(t.minutes * (0.75 + rnd() * 0.5)));
        }
      } else if (r < rate + 0.12) {
        t.status = 'half';
      }
    });
    /* 感受跟完成情况挂钩：做得顺就是轻松，做不动就是累 */
    var r2 = rnd();
    if (rate < 0.6) day.mood = r2 < 0.5 ? 'hard' : 'tired';
    else if (rate > 0.9) day.mood = r2 < 0.5 ? 'easy' : 'ok';
    else day.mood = r2 < 0.4 ? 'ok' : (r2 < 0.7 ? 'tired' : 'easy');
  }

  function simulateForward(days, rate) {
    /* 先备份，随时能还原 */
    state.devBackup = JSON.stringify({
      simDate: state.simDate, days: state.days, roadmap: state.roadmap,
      weeklyLog: state.weeklyLog, weekMark: state.weekMark,
    });

    var rnd = makeRnd(20260918 + days);
    var d = E.parseKey(todayKey());
    var done = 0;
    for (var i = 0; i < days; i++) {
      var dk = E.toKey(d);
      state.simDate = dk;
      dailyRoll();                       // 和真实打开 App 走同一条路径
      var day = state.days[dk];
      if (day && !day.isRest) { simulateCheckin(day, rate, rnd); done++; }
      d = E.addDays(d, 1);
    }
    state.simDate = E.toKey(d);
    dailyRoll();
    save();
    return done;
  }

  function restoreDev() {
    if (!state.devBackup) return false;
    var b = JSON.parse(state.devBackup);
    state.simDate = b.simDate;
    state.days = b.days;
    state.roadmap = b.roadmap;
    state.weeklyLog = b.weeklyLog;
    state.weekMark = b.weekMark;
    if (b.onboarding && b.profile) state.profile = b.profile;
    state.devBackup = null;
    save();
    return true;
  }

  function devRows() {
    var rate = state.ui.simRate || 0.75;
    function rateBtn(v, label) {
      return '<button class="chip ' + (rate === v ? 'on' : '') + '" data-act="sim-rate" data-v="' + v + '">' + label + '</button>';
    }
    return '<div class="param-row">' +
      '<div class="param-note">这一块只有你自己用，发布给朋友时会隐藏。' +
      '快进会按你选的完成率把中间每一天都跑一遍——周重排、任务顺延、阶段推进走的都是真实逻辑，不是造出来的假数据。跑完可以一键还原。</div>' +
      '<div class="param-head" style="margin-top:10px"><span class="param-label">模拟完成率</span></div>' +
      '<div class="chips" style="margin-top:6px">' +
        rateBtn(0.5, '50% 经常完不成') + rateBtn(0.75, '75% 一般') + rateBtn(0.95, '95% 很稳') +
      '</div>' +
      '<div class="param-head" style="margin-top:14px"><span class="param-label">快进</span></div>' +
      '<div class="chips" style="margin-top:6px">' +
        '<button class="chip" data-act="sim-run" data-v="7">7 天</button>' +
        '<button class="chip" data-act="sim-run" data-v="30">30 天</button>' +
        '<button class="chip" data-act="sim-run" data-v="60">60 天</button>' +
        '<button class="chip" data-act="sim-run" data-v="120">120 天</button>' +
      '</div>' +
      '<div class="param-note" style="margin-top:12px">' +
        '想自己每天点一遍的话用下面这个——它只把日期往后拨一天，不帮你打卡，' +
        '然后你就像平常一样勾任务、选感受，再拨下一天。这样验证到的就是你真实的操作路径。</div>' +
      '<div class="chips" style="margin-top:6px">' +
        '<button class="chip" data-act="sim-next">过一天 →</button>' +
        (state.simDate ? '<button class="chip" data-act="sim-today">回到真实今天</button>' : '') +
      '</div>' +
      '<div class="param-note" style="margin-top:12px">当前日期：<b>' + todayKey() + '</b>' +
        (state.simDate ? '（真实今天是 ' + realTodayKey() + '）' : '') + '</div>' +
      '<div class="param-head" style="margin-top:14px"><span class="param-label">模拟断更</span></div>' +
      '<div class="chips" style="margin-top:6px">' +
        '<button class="chip" data-act="sim-break" data-v="5">停 5 天后回来</button>' +
        '<button class="chip" data-act="sim-break" data-v="12">停 12 天后回来</button>' +
      '</div>' +
      '<div class="param-note" style="margin-top:8px">' +
        '直接跳到"断更 N 天之后"，看看回来那天自动弹出的学习档案、' +
        '以及那些天没做完的东西是不是真的没被算成欠账。</div>' +
      (state.devBackup
        ? '<button class="btn ghost block" style="margin-top:10px" data-act="sim-restore">还原到快进前</button>'
        : '') +
      '<button class="btn ghost block" style="margin-top:10px" data-act="sim-restart">重走一遍问卷</button>' +
      '<div class="param-note">重走问卷会先自动备份，走完之后可以点上面的"还原"退回来。' +
      '这样你就能反复看刚进项目的那几个界面了。</div>' +
    '</div>';
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

    /* 0. 断了很久回来：把断更期间"排了但一下都没碰"的日子清掉。
     * 必须放在顺延之前，否则那些天没做完的东西会被顺延到未来，
     * 用户一打开就是一屁股债——这正是他要卸载的时刻。 */
    var ri = E.applyRestart(state, tk);
    if (ri && state.ui.restartSeenOn !== tk) {
      state.ui.restartSeenOn = tk;
      pendingRestart = ri;
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

  /* 用当前问卷内容试算一遍，让用户看到"我的选择产生了什么结果" */
  function previewPlan() {
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
      courseUnits: draft.courseUnits,
      benchmarks: {},
      strength: {},
    };
    MODULES.forEach(function (m) { p.strength[m.id] = 'normal'; });
    try { return E2.buildRoadmap(p, today); } catch (e) { return null; }
  }

  function previewHtml() {
    var rm = previewPlan();
    if (!rm) return '';
    var totalUnits = 0, totalMinutes = 0;
    var E2 = window.YT.engine;
    MODULES.forEach(function (m) {
      var n = E2.targetUnits(m, {
        courseUnits: draft.courseUnits, strength: { slw: 'normal' },
      });
      totalUnits += n;
    });
    totalMinutes = Math.round(totalUnits * (Number(draft.lessonMinutes) || 150) / (Number(draft.speed) || 1.5));

    var st = rm.stages;
    var f = baseFactor();
    var note = f < 1
      ? '因为你说「' + baseLabel() + '」，每科的课都按 ' + Math.round(f * 100) + '% 折算过了，你可以在这上面直接改。'
      : '这些数字可以按你手上的课直接改。';

    return '<div class="preview-card">' +
      '<div class="pv-title">按现在的填写，你的计划会是这样</div>' +
      '<div class="pv-row"><span>要听的课</span><b>' + totalUnits + ' 节 · 约 ' +
        Math.round(totalMinutes / 60) + ' 小时</b></div>' +
      '<div class="pv-row"><span>基础期</span><b>' + st[0].studyDays + ' 个学习日</b></div>' +
      '<div class="pv-row"><span>强化期</span><b>' + st[1].studyDays + ' 个学习日</b></div>' +
      '<div class="pv-row"><span>冲刺期</span><b>' + st[2].studyDays + ' 个学习日</b></div>' +
      '<div class="pv-note">' + esc(note) + '</div>' +
    '</div>';
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
      body = '<h2>每个模块你打算听多少节课？</h2>' +
             '<p class="lead">不是"你买了多少"，是"你打算听多少"。以后听完想加，把数字往上改就行。</p>' +
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
    var rowCls = t.status === 'done' ? ' is-done' : '';
    var body =
      '<div class="task-top">' +
        '<span class="task-title">' + esc(t.title) + '</span>' +
        '<span class="task-min">' + fmtMinutes(t.minutes) + '</span>' +
      '</div>' +
      (taskDetail(t) ? '<div class="task-detail">' + esc(taskDetail(t)) + '</div>' : '') +
      ((t.carried || t.status === 'half' || t.userAdded)
        ? '<div class="task-meta">' +
            (t.review ? '<span class="pill plain">回顾</span>'
                      : (t.userAdded ? '<span class="pill plain">自己加的</span>' : '')) +
            (t.carried ? '<span class="pill warn">顺延</span>' : '') +
            (t.status === 'half' ? '<span class="pill">完成一半</span>' : '') +
          '</div>'
        : '');

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
      '<button class="del" data-act="del-task" data-date="' + dateKey + '" data-task="' + esc(t.id) + '" title="删掉这项">×</button>' +
    '</div>';
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
    var doneCount = (day.tasks || []).filter(function (t) { return t.status === 'done'; }).length;
    var totalCount = (day.tasks || []).length;
    var head = '<div class="today-head">' +
      '<div class="date">' + fmtDate(tk, true) + '　' + weekdayName(tk) + '</div>' +
      '<h1>' + (day.isRest ? '今天休息' : '今天') + '</h1>' +
      '<div class="state">' +
        '<i>' + stageLabel(day.stage) + '</i>' +
        (totalCount ? ' · 已完成 <b>' + doneCount + ' / ' + totalCount + '</b> 项' : '') +
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
    var tasksHtml = (day.tasks || []).map(function (t) { return renderTask(t, tk); }).join('');
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

    app.innerHTML = '<div class="screen">' + head +
      (staleHtml ? '<div class="section">' + staleHtml + '</div>' : '') +
      (allDone ? '<div class="section"><div class="done-note">今天全部完成</div></div>' : '') +

      '<div class="section"><div class="card tasks">' + tasksHtml + '</div></div>' +

      '<div class="section">' + freeHtml + extraFormHtml() +
        (state.ui.addingExtra ? '' :
          '<button class="btn block ghost" data-act="extra-open">加一项</button>') +
      '</div>' +

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
    /* 老数据里可能没有这个字段（那时候还没算强化期），先兜一下 */
    var capH = isFinite(lc && lc.capacityMinutes) ? Math.round(lc.capacityMinutes / 60) : 0;
    if (lc && !lc.fit) {
      checkHtml = '<div class="section"><div class="card" style="background:var(--accent-s);box-shadow:none">' +
        '<div style="font-weight:600;color:var(--accent)">课时量偏大</div>' +
        '<div class="tiny" style="margin-top:4px;color:var(--ink-2)">' +
        '听课要 <b>' + Math.round(lc.totalMinutes / 60) + ' 小时</b>，' +
        '但基础期加强化期只放得下 <b>' + capH + ' 小时</b>。会挤压刷题。</div>' +
        '<div class="tiny" style="margin-top:6px;color:var(--ink-3)">' +
        '办法：提高倍速、少听几节、或者把每天的时间调高。</div>' +
        '<button class="btn sm ghost" style="margin-top:10px" data-act="goto" data-to="settings">去调整</button>' +
        '</div></div>';
    } else if (lc) {
      checkHtml = '<div class="section"><div class="card" style="background:var(--primary-s);box-shadow:none">' +
        '<div class="tiny" style="color:var(--primary)">课时量排得下：听课 ' + Math.round(lc.totalMinutes / 60) +
        ' 小时，基础期加强化期放得下 ' + capH + ' 小时。</div>' +
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

    app.innerHTML = '<div class="screen">' +
      '<div class="top"><h1>我的计划</h1>' +
      '<div class="sub">距离 ' + fmtDate(profile.examDate, true) + ' 还有 ' + rm.totalStudyDays + ' 个学习日</div></div>' +

      '<div class="section"><p class="section-title">总体节奏</p><div class="card">' + stagesHtml + '</div></div>' +
      checkHtml +
      logHtml +

      '<div class="section"><p class="section-title">日程</p>' + rangeBar +
        '<div class="card" style="margin-top:10px">' + daysHtml + '</div></div>' +
      '<div class="section"><p class="section-title">听课进度</p><div class="card">' +
        progHead + progRows + '</div></div>' +
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
      '<div class="pd-right">' +
        '<span class="pd-total">' + (isRest ? '休息' : (total ? fmtMinutes(total) : '—')) + '</span>' +
        '<button class="pd-add" data-act="extra-open-day" data-v="' + k + '" title="给这天加一项">＋</button>' +
      '</div>' +
    '</div>';

    var formHere = (state.ui.addingExtra && state.ui.extraDate === k) ? extraFormHtml() : '';

    if (isRest) return '<div class="plan-day rest' + (collapsible ? ' foldable' : '') + '">' + head + formHere + '</div>';
    if (!day) {
      return k < tk
        ? '<div class="plan-day past">' + head + formHere + '</div>'
        : '<div class="plan-day">' + head + '<div class="pd-stage">还没排到</div>' + formHere + '</div>';
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
        body + formHere + '</div>';
    }

    return '<div class="plan-day">' + head +
      '<div class="pd-stage">' + stageName + '</div>' +
      '<div class="pd-tasks">' + taskRows(day) + '</div>' + formHere + '</div>';
  }

  function taskRows(day) {
    return (day.tasks || []).map(function (t) {
      var mark = t.status === 'done' ? '<i class="pd-mark done">✓</i>'
               : t.status === 'half' ? '<i class="pd-mark half">◐</i>' : '';
      return '<div class="pd-task">' +
        '<span class="pd-t">' + mark + esc(t.title) + '</span>' +
        '<span class="pd-d">' + esc(taskDetail(t)) + '</span>' +
        '<span class="pd-min">' + t.minutes + ' 分</span>' +
        '<button class="del" data-act="del-task" data-date="' + day.date + '" data-task="' + esc(t.id) + '" title="删掉这项">×</button>' +
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
    var scores = state.scores || [];
    var archQ = window.YT.archive.build(state, tk, (state.days[tk] || {}).stage || 'base');

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
      '<div class="top"><h1>统计</h1><div class="sub">这些数字用来把计划调得越来越贴合你</div></div>' +

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
      return '<div style="padding:9px 0;border-bottom:1px solid var(--line)">' +
        '<div class="row between" style="margin-bottom:6px"><span style="font-size:13.5px">' + esc(m.short) + '</span>' +
        '<span class="tiny muted">' + summary + '</span></div>' +
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
            var need = E.targetUnits(m, p);
            var doneM = Math.min(need, E.courseProgress(state)[m.id] || 0);
            var sub = need > 0
              ? '<span class="unit">已听 ' + doneM + ' · 剩 ' + (need - doneM) + '</span>'
              : '';
            return '<div class="item"><label>' + esc(m.short) + '</label>' +
              '<input type="number" min="0" step="1" data-act="set-units" data-m="' + m.id + '" value="' + v + '">' +
              '<span class="unit">节</span>' + sub + '</div>';
          }).join('') +
        '</div>' +
        '<div class="footnote">填你打算听多少节，不是买了多少节。想加课就往上改，已经听过的不重来。</div>' +
        '<button class="btn ghost block" style="margin-top:10px" data-act="no-course-settings">不听课，全部设为 0</button>' +
      '</div></div>' +

      '<div class="section"><p class="section-title">各模块强度</p>' +
        '<div class="card" style="padding-top:4px;padding-bottom:4px">' + strengthRows + '</div>' +
        '<div class="footnote">有底子的选「减少」，打算放弃的选「不学」（比如数量关系）。改完点最下面重排。</div>' +
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

      (SHOW_DEV ? '<div class="section"><p class="section-title">开发者工具</p><div class="card">' +
        '<button class="param-toggle" data-act="toggle-dev">' +
          (state.ui.showDev ? '收起 ▲' : '展开 ▼') +
          '<span>快进模拟，只有你自己用</span>' +
        '</button>' +
        (state.ui.showDev ? devRows() : '') +
      '</div></div>' : '') +

      '<div class="sticky-cta above-tabs"><button class="btn primary block" data-act="regen">重新生成后面的计划</button></div>' +
      '</div>';
    renderTabbar('settings');
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
           essayStartRow() +
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
      plan: '<path d="M4.5 7h15M4.5 12h15M4.5 17h9"/>',
      stats: '<path d="M6 19v-6M12 19V5.5M18 19v-9"/>',
      settings: '<path d="M4 8.5h8M17 8.5h3M4 15.5h3M12 15.5h8"/><circle cx="14.5" cy="8.5" r="2.2"/><circle cx="9.5" cy="15.5" r="2.2"/>',
    };
    var tabs = [
      { id: 'today', label: '今日' },
      { id: 'plan', label: '计划' },
      { id: 'stats', label: '统计' },
      { id: 'settings', label: '设置' },
    ];
    var html = '<div class="tabbar">' + tabs.map(function (t) {
      return '<button class="tab ' + (t.id === active ? 'on' : '') + '" data-act="goto" data-to="' + t.id + '">' +
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
    if (!state.profile) { app.className = ''; renderOnboarding(); return; }
    var rtk = todayKey();
    var rstage = (state.days[rtk] || {}).stage || 'base';
    rebuildCourseLabels();
    var s = state.ui.screen || 'today';
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
    else if (s === 'stats') out = renderStats();
    else if (s === 'settings') out = renderSettings();
    else out = renderToday();

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

    /* ---- 打卡 ---- */
    if (act === 'cycle') {
      var dk = el.getAttribute('data-date');
      var tid = el.getAttribute('data-task');
      var day = state.days[dk];
      if (!day) return;
      var task = (day.tasks || []).filter(function (t) { return t.id === tid; })[0];
      if (!task) return;
      var next = task.status === 'todo' ? 'done' : task.status === 'done' ? 'half' : 'todo';
      setTaskStatus(task, next);
      if (next !== 'done') task.actualMinutes = null;
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
        (removed.kind === 'course' ? '——这节课会顺延到后面。' : '——不影响后面的安排。'),
        function () {
          var before = takeSnapshot();
          var dd2 = state.days[ddk];
          if (!dd2) return;
          if (removed.kind === 'course') {
            /* 同一天同一模块的课全一起去掉，不然"下半节"会挂在上半节没了的情况下 */
            dd2.tasks = dd2.tasks.filter(function (t) {
              return !(t.kind === 'course' && t.moduleId === removed.moduleId);
            });
            Object.keys(state.days).forEach(function (k) {
              if (k <= ddk) return;
              var dd = state.days[k];
              var touched = dd.mood || (dd.tasks || []).some(function (t) { return t.status !== 'todo'; });
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
            var touched = dd.mood || (dd.tasks || []).some(function (t) { return t.status !== 'todo'; });
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
          id: 'extra-' + Date.now(),
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
          id: 'extra-' + Date.now(),
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
            id: 'extra-' + Date.now(),
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
            id: 'extra-' + Date.now(),
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
          var touched = dd.mood || (dd.tasks || []).some(function (t) { return t.status !== 'todo'; });
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
      return reRender();
    }
    if (act === 'toggle-dev') {
      state.ui.showDev = !state.ui.showDev;
      save();
      return reRender();
    }
    if (act === 'sim-rate') {
      state.ui.simRate = Number(el.getAttribute('data-v'));
      save();
      return reRender();
    }
    if (act === 'sim-run') {
      var nDays = Number(el.getAttribute('data-v'));
      var rate = state.ui.simRate || 0.75;
      var startKey = todayKey();
      var ran = simulateForward(nDays, rate);
      toast('已快进 ' + nDays + ' 天（' + ran + ' 个学习日）');
      go('plan');
      return;
    }
    if (act === 'sim-restore') {
      if (restoreDev()) { toast('已还原'); go('today'); }
      else toast('没有可还原的快照');
      return;
    }
    if (act === 'sim-restart') {
      state.devBackup = JSON.stringify({
        simDate: state.simDate, days: state.days, roadmap: state.roadmap,
        weeklyLog: state.weeklyLog, weekMark: state.weekMark,
        profile: state.profile, onboarding: true,
      });
      state.profile = null;
      state.days = {};
      state.roadmap = null;
      state.weeklyLog = [];
      state.weekMark = {};
      state.simDate = null;
      state.ui.onboardStep = 0;
      state.ui.screen = 'today';
      draft = null;
      save();
      render();
      toast('已重置，可以重新走问卷');
      return;
    }
    /* 只拨日期，不自动打卡。让用户像平常一样自己点一遍，验证真实的操作路径。 */
    if (act === 'sim-next') {
      var nd = E.addDays(E.parseKey(todayKey()), 1);
      state.simDate = E.toKey(nd);
      dailyRoll();
      save();
      go('today');
      toast('现在是 ' + state.simDate + '（模拟）');
      return;
    }
    if (act === 'sim-today') {
      state.simDate = null;
      dailyRoll();
      save();
      go('today');
      toast('已回到真实今天');
      return;
    }
    /* 断更测试：直接跳到"上次学习结束 N 天之后"，走真实的重启逻辑 */
    if (act === 'sim-break') {
      var bd = Number(el.getAttribute('data-v')) || 8;
      var lastK = E.lastActiveKey(state, todayKey()) || todayKey();
      state.simDate = E.toKey(E.addDays(E.parseKey(lastK), bd));
      state.ui.restartSeenOn = null;   // 让学习档案重新弹出来
      dailyRoll();
      save();
      go('today');
      return;
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
    if (act === 'chg-undo') {
      if (!lastUndo) return closeModal();
      state.days = lastUndo.days;
      state.weeklyLog = lastUndo.weeklyLog;
      state.weekMark = lastUndo.weekMark;
      lastUndo = null;
      save();
      closeModal();
      render();
      toast('已撤销');
      return;
    }
    if (act === 'chg-ok') { lastUndo = null; return closeModal(); }

    /* ---- 成绩记录 ---- */
    if (act === 'score-open') return openScoreForm();
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
        var touched = dd.mood || (dd.tasks || []).some(function (t) { return t.status !== 'todo'; });
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
    if (act === 'arch-close') { archDraft = null; return closeModal(); }
    if (act === 'arch-toggle') {
      if (!archDraft) return;
      var ai = Number(el.getAttribute('data-i'));
      if (archDraft.items[ai]) archDraft.items[ai].on = !archDraft.items[ai].on;
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

    if (act === 'set-units') {
      var mid = el.getAttribute('data-m');
      var val = el.value === '' ? '' : Number(el.value);
      if (state.profile) { state.profile.courseUnits[mid] = val; save(); }
      else if (draft) {
        draft.courseUnits[mid] = val;
        /* 不整页重渲染（会丢焦点），只把下面那块预览换掉 */
        var pv = document.getElementById('ob-preview');
        if (pv) pv.innerHTML = previewHtml();
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
    var act = el.getAttribute('data-act');
    if (act === 'set-exam') { state.profile.examDate = el.value; save(); }
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
      dailyRoll();
      save();
    }
    render();
  }

  /* 调试用：在浏览器控制台里输入 __ytDebug() 就能看到当前状态 */
  window.__ytDebug = function () { return state; };

  boot();
})();
