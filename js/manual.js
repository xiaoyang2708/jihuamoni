/* =========================================================================
 * manual.js —— 自己排：清单的数据操作 + 渲染
 *
 * 这个模块是"独立分支"的主体。它只认两样东西：
 *   state.days[k].tasks[]   —— 按天的容器（跟自动/半自动共用）
 *   state.manual            —— 清单自己的界面开关
 * 系统排课的东西（阶段、预测、砍课、顺延）这里一个字都不碰。
 *
 * 一条清单项长这样（除标题外全部可选）：
 *   { id, kind:'task', title, userAdded:true,
 *     moduleId, moduleName,           // 科目标签
 *     work:{sets?,units?,amount?},         // 工作量：几组 / 几节 / 几题
 *     minutes,                        // 预计时长
 *     note, subtasks:[{id,title,done}],
 *     repeat:{freq,until}|null, remind:{on,time}|null,
 *     order, status, actualMinutes, focusMinutes }
 *
 * 收集箱本轮不做，但结构已经留好位置：date 传 null 就是一个视图的事，
 * 模型不用动（add(state, null, …)）。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  var E = YT.engine;

  /* ---------------------------------------------------------------------
   * 小工具（这个模块刻意自给自足，挂到别的板块也能直接搬）
   * ------------------------------------------------------------------- */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var seq = 0;
  function uid(prefix) {
    seq++;
    return (prefix || 'm-') + Date.now() + '-' + seq;
  }

  function fmtMinutes(m) {
    m = Math.round(Number(m) || 0);
    if (m <= 0) return '';
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' 小时 ' + r + ' 分' : h + ' 小时';
  }

  function fmtDate(key) {
    if (!key) return '—';
    var d = E.parseKey(key);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function weekdayName(key) {
    return '周' + YT.WEEKDAY_NAMES[E.parseKey(key).getDay()];
  }

  function moduleNameOf(id) {
    var m = YT.MODULE_BY_ID && YT.MODULE_BY_ID[id];
    return m ? m.name : '';
  }

  /* ---- 科目标签 --------------------------------------------------------
   * 预设标签在 config.js 的 YT.TAGS 里（资料 / 言语 / 判断推理 / 政治 / 数量 /
   * 常识 / 申论）；自定义标签存在 state.manual.tags。两者拼起来就是全部。
   * ------------------------------------------------------------------- */

  function customTags(state) {
    settings(state);   // 保证 state.manual 存在
    if (!Array.isArray(state.manual.tags)) state.manual.tags = [];
    return state.manual.tags;
  }

  /* 预设 + 自定义 */
  function tags(state) {
    return (YT.TAGS || []).slice().concat(customTags(state).map(function (t) {
      return { id: t.id, name: t.name };
    }));
  }

  function tagById(state, id) {
    if (!id) return null;
    var cid = YT.tagIdOf(id);
    var all = tags(state);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === cid) return all[i];
    }
    return null;
  }

  /* 标签显示名：预设 > 自定义 > 条目上存的名字 > 空 */
  function tagLabel(state, id, fallbackName) {
    if (!id) return fallbackName || '';
    var t = tagById(state, id);
    if (t) return t.name;
    return fallbackName || moduleNameOf(YT.tagIdOf(id)) || '';
  }

  /* 新建一个自定义标签。重名（含预设）直接返回已有的；空值返回 null。 */
  function addTag(state, rawName) {
    var name = String(rawName === undefined || rawName === null ? '' : rawName).trim().slice(0, 8);
    if (!name) return null;
    var all = tags(state);
    for (var i = 0; i < all.length; i++) {
      if (all[i].name === name) return all[i];
    }
    var t = { id: 'u-' + Date.now(), name: name };
    customTags(state).push(t);
    return t;
  }

  /* 改名：同步更新所有用到它的条目，统计里跟着变。 */
  function renameTag(state, id, rawName) {
    var name = String(rawName === undefined || rawName === null ? '' : rawName).trim().slice(0, 8);
    if (!name) return false;
    var t = customTags(state).filter(function (x) { return x.id === id; })[0];
    if (!t) return false;
    t.name = name;
    Object.keys(state.days || {}).forEach(function (k) {
      (state.days[k].tasks || []).forEach(function (x) {
        if (x.moduleId === id) x.moduleName = name;
      });
    });
    return true;
  }

  /* 这个标签被用在哪、一共多久（删之前要告诉用户） */
  function tagUsage(state, id) {
    var items = 0, minutes = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      (state.days[k].tasks || []).forEach(function (x) {
        if (x.moduleId !== id) return;
        items++;
        minutes += YT.stats.effectiveMinutes(x);
      });
    });
    return { items: items, minutes: Math.round(minutes) };
  }

  /* 删除标签。mode：
   *   'records' —— 连记录一起删（清单条目 + 挂在这些条目上的计时记录）
   *   'only'    —— 只删标签，条目保留但变成「未指定」
   */
  function deleteTag(state, id, mode) {
    var stat = tagUsage(state, id);
    Object.keys(state.days || {}).forEach(function (k) {
      var day = state.days[k];
      if (!day || !Array.isArray(day.tasks)) return;
      if (mode === 'records') {
        var gone = [];
        day.tasks = day.tasks.filter(function (x) {
          if (x.moduleId !== id) return true;
          gone.push(x.id);
          return false;
        });
        if (state.focus && Array.isArray(state.focus.sessions)) {
          state.focus.sessions = state.focus.sessions.filter(function (s) {
            if (s.moduleId === id) return false;
            if (s.taskId && gone.indexOf(s.taskId) !== -1) return false;
            return true;
          });
        }
      } else {
        day.tasks.forEach(function (x) {
          if (x.moduleId === id) { x.moduleId = null; x.moduleName = ''; }
        });
        if (state.focus && Array.isArray(state.focus.sessions)) {
          state.focus.sessions.forEach(function (s) {
            if (s.moduleId === id) delete s.moduleId;
          });
        }
      }
    });
    state.manual.tags = customTags(state).filter(function (x) { return x.id !== id; });
    return stat;
  }

  /* ---------------------------------------------------------------------
   * 模式与设置
   * ------------------------------------------------------------------- */

  function isOn(state) {
    return !!(state && E.isManual(state.profile));
  }

  function settings(state) {
    if (!state.manual || typeof state.manual !== 'object') state.manual = {};
    if (!state.manual.settings || typeof state.manual.settings !== 'object') state.manual.settings = {};
    var adv = state.manual.settings.advanced;
    if (!adv || typeof adv !== 'object') adv = state.manual.settings.advanced = {};
    ['subtask', 'repeat', 'remind'].forEach(function (k) {
      if (adv[k] !== true) adv[k] = false;
    });
    return state.manual.settings;
  }

  function setAdvanced(state, key, on) {
    var s = settings(state);
    if (s.advanced[key] === undefined) return;
    s.advanced[key] = !!on;
  }

  /* 把所有任务补上清单需要的字段。老档案缺什么补什么。 */
  function normalize(t) {
    if (!t) return t;
    if (t.status === undefined) t.status = 'todo';
    if (t.actualMinutes === undefined) t.actualMinutes = null;
    if (t.focusMinutes === undefined) t.focusMinutes = Number(t.actualMinutes) || 0;
    if (Array.isArray(t.subtasks)) {
      t.subtasks.forEach(function (s) {
        if (!s.id) s.id = uid('s-');
        s.done = !!s.done;
        s.title = String(s.title === undefined ? '' : s.title);
      });
    }
    if (t.kind === 'task') {
      if (!t.work || typeof t.work !== 'object') t.work = null;
      if (!t.note) t.note = '';
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      if (t.repeat === undefined) t.repeat = null;
      if (t.remind === undefined) t.remind = null;
    }
    return t;
  }

  function ensureDay(state, key) {
    if (!key) return null;
    var day = state.days[key];
    if (!day) {
      day = state.days[key] = {
        date: key, isRest: false, stage: null, tasks: [], mood: null,
        generatedAt: new Date().toISOString(),
      };
    }
    if (day.isRest) day.isRest = false;   // 休息日上加了任务，就当学习日
    if (!Array.isArray(day.tasks)) day.tasks = [];
    return day;
  }

  /* 按 order 排好。order 一样或缺失时按原来的先后顺序，保证稳定。 */
  function ordered(day) {
    if (!day || !day.tasks) return [];
    var arr = day.tasks.slice();
    arr.forEach(function (t, i) { if (typeof t.order !== 'number') t.order = i + 1; });
    arr.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    return arr;
  }

  function nextOrder(day) {
    var max = 0;
    (day.tasks || []).forEach(function (t) {
      if (typeof t.order === 'number' && t.order > max) max = t.order;
    });
    return max + 1;
  }

  function find(state, key, id) {
    var day = state.days[key];
    if (!day) return null;
    return (day.tasks || []).filter(function (t) { return t.id === id; })[0] || null;
  }

  /* 工作量文字，例如 "3 组" / "20 题" / "2 节"。 */
  function workText(t) {
    if (!t) return '';
    if (t.kind === 'task') {
      var w0 = t.work || {};
      if (w0.sets) return w0.sets + ' 组';
      if (w0.units) return w0.units + ' 节';
      if (w0.amount) return w0.amount + (t.moduleId === 'slw' ? ' 道' : ' 题');
      return '';
    }
    var w = E.taskWork(t);
    if (!w) return '';
    if (w.type === 'practice' && w.amount) return w.amount + ' 题';
    if (w.type === 'course' && w.units) return w.units + ' 节';
    if (w.type === 'essay') return (w.count || 1) + ' 道';
    if (w.type === 'paperset') return '1 套';
    return '';
  }

  function subjectName(state, t) {
    if (!t) return '';
    return tagLabel(state, t.moduleId, t.moduleName);
  }

  /* 科目标签的显示名：资料 / 判断推理 / 申论 / 自定义 … */
  function subjectLabel(state, id) {
    if (!id) return '';
    return tagLabel(state, id, '');
  }

  function subtaskStat(t) {
    var list = (t && t.subtasks) || [];
    var done = list.filter(function (s) { return s.done; }).length;
    return { done: done, total: list.length };
  }

  /* 这一天的目标时长。系统不排课，但"我今天想学多久"仍然有用——
   * 用它给"今天排了多久"当参照线，超了就只是换个颜色，不报警。 */
  function dailyTarget(state, key) {
    var p = (state && state.profile) || {};
    var wd = E.parseKey(key).getDay();
    var v = (wd === 0 || wd === 6) ? Number(p.weekendMinutes) : Number(p.weekdayMinutes);
    return isFinite(v) && v > 0 ? Math.round(v) : 0;
  }

  /* ---------------------------------------------------------------------
   * 增删改
   * ------------------------------------------------------------------- */

  function cloneTask(t) {
    var c = JSON.parse(JSON.stringify(t));
    c.id = uid('m-');
    if (Array.isArray(c.subtasks)) {
      c.subtasks.forEach(function (s) { s.id = uid('s-'); s.done = false; });
    }
    c.status = 'todo';
    c.actualMinutes = null;
    c.focusMinutes = 0;
    c.createdAt = new Date().toISOString();
    return c;
  }

  /* 把重复规则展开成未来几天里的具体条目。
   * 只展开到"截止日期"或最多 40 条，别让一个规则炸出几百条。 */
  function expandRepeat(state, baseKey, task) {
    var rep = task.repeat;
    if (!rep || !rep.freq || rep.freq === 'none') return 0;
    var until = rep.until || E.toKey(E.addDays(E.parseKey(baseKey), 60));
    var baseWd = E.parseKey(baseKey).getDay();
    var d = E.addDays(E.parseKey(baseKey), 1);
    var made = 0, guard = 0;
    while (guard < 400 && made < 40) {
      guard++;
      var k = E.toKey(d);
      if (k > until) break;
      var wd = E.parseKey(k).getDay();
      var hit = rep.freq === 'daily' ? true
              : rep.freq === 'weekdays' ? (wd >= 1 && wd <= 5)
              : rep.freq === 'weekly' ? (wd === baseWd)
              : false;
      if (hit) {
        var copy = cloneTask(task);
        copy.repeat = null;
        copy.repeatOf = task.id;
        copy.seriesId = task.seriesId;
        copy.seriesFreq = rep.freq;   // 副本自己带着频率，才认得自己属于哪种重复
        var day = ensureDay(state, k);
        copy.order = nextOrder(day);
        day.tasks.push(copy);
        made++;
      }
      d = E.addDays(d, 1);
    }
    return made;
  }

  /* 加一条。fields 里已经带好 moduleId/work/minutes/note/... */
  function add(state, key, fields) {
    fields = fields || {};
    var day = ensureDay(state, key);
    if (!day) return null;
    var task = {
      id: uid('m-'),
      kind: 'task',
      userAdded: true,
      title: String(fields.title || '').trim() || '未命名',
      moduleId: fields.moduleId || null,
      moduleName: fields.moduleId ? subjectLabel(state, fields.moduleId) : '',
      minutes: Math.max(0, Math.round(Number(fields.minutes) || 0)),
      note: fields.note || '',
      work: fields.work || null,   // 几组 / 几节 / 几题：批量排和档案回顾会用到
      subtasks: (fields.subtasks || []).map(function (s) {
        return { id: uid('s-'), title: String(s.title || ''), done: false };
      }),
      repeat: fields.repeat || null,
      remind: fields.remind || null,
      order: nextOrder(day),
      status: 'todo',
      actualMinutes: null,
      focusMinutes: 0,
      createdAt: new Date().toISOString(),
    };
    /* 一次重复展开出来的一串条目挂同一个系列号：
     * 以后「改这一串」「以后都删掉」都靠它认人。单条不挂。 */
    if (task.repeat && task.repeat.freq && task.repeat.freq !== 'none') {
      task.seriesId = 's-' + task.id;
    }
    day.tasks.push(task);
    var extra = expandRepeat(state, key, task);
    return { task: task, extra: extra };
  }

  /* ---------------------------------------------------------------------
   * 重复系列
   *
   * 一个系列 = 原条 + 它展开出来的所有副本，靠 seriesId 认。
   * 老数据只有 repeatOf（指向原条 id），也认。规则只有一条：
   * **已打卡的历史不可改写**，系列动作只碰"今天及以后、还没打卡"的条目。
   * ------------------------------------------------------------------- */

  function seriesIdOf(t) {
    if (!t) return null;
    if (t.seriesId) return t.seriesId;
    if (t.repeatOf) return 's-' + t.repeatOf;
    return null;
  }

  function seriesMembers(state, sid) {
    var out = [];
    if (!sid) return out;
    Object.keys(state.days || {}).sort().forEach(function (k) {
      ((state.days[k] || {}).tasks || []).forEach(function (t) {
        if (seriesIdOf(t) === sid) out.push({ key: k, task: t });
      });
    });
    return out;
  }

  /* 今天及以后的那部分（今天这条也算，历史不算）。 */
  function futureMembers(state, sid, tk) {
    return seriesMembers(state, sid).filter(function (m) {
      return !tk || m.key >= tk;
    });
  }

  /* 卡片上那句「每天 · 还有 12 条」 */
  function seriesLabel(t) {
    if (!t) return '';
    var freq = (t.repeat && t.repeat.freq) || t.seriesFreq || '';
    return freq === 'daily' ? '每天'
         : freq === 'weekdays' ? '工作日'
         : freq === 'weekly' ? '每周' : '重复';
  }

  /* 以后都删掉：今天及以后、还没打卡的整串删掉。
   * 返回删掉的那几条（界面拿去支持撤销）。 */
  function dropSeriesFuture(state, sid, tk) {
    var doomed = futureMembers(state, sid, tk).filter(function (m) {
      return m.task.status === 'todo';
    });
    doomed.forEach(function (m) {
      var day = state.days[m.key];
      if (!day) return;
      day.tasks = (day.tasks || []).filter(function (x) { return x !== m.task; });
      if (!day.tasks.length) delete state.days[m.key];
      else renumber(day);
    });
    return doomed;
  }

  /* 复制一条：同一天多出一份一样的，打卡/专注/子任务勾选全部清空。
   * 复制出来的是一条全新的独立条目，不带系列号——不然它会跟着原来那串一起被改被删。 */
  function duplicate(state, key, id) {
    var t = find(state, key, id);
    if (!t) return null;
    var day = ensureDay(state, key);
    if (!day) return null;
    var c = cloneTask(t);
    c.repeat = null;
    c.repeatOf = null;
    delete c.seriesId;
    delete c.seriesFreq;
    delete c.log;
    c.order = nextOrder(day);
    day.tasks.push(c);
    renumber(day);
    return c;
  }

  /* 改到别的日子。两边的编号都重排一次，不动任何打卡数据。 */
  function moveToDay(state, fromKey, id, toKey) {
    if (!toKey || !fromKey || fromKey === toKey) return false;
    var t = find(state, fromKey, id);
    if (!t) return false;
    var from = state.days[fromKey];
    from.tasks = (from.tasks || []).filter(function (x) { return x !== t; });
    if (!from.tasks.length) delete state.days[fromKey];
    else renumber(from);
    var to = ensureDay(state, toKey);
    if (!to) return false;
    t.order = nextOrder(to);
    to.tasks.push(t);
    renumber(to);
    return true;
  }

  /* 一条任务"还有几件同系列的事在后面"（含它自己），菜单上要写数字。 */
  function seriesFutureCount(state, t, tk) {
    var sid = seriesIdOf(t);
    if (!sid) return 0;
    return futureMembers(state, sid, tk).length;
  }

  /* ---------------------------------------------------------------------
   * 「⋯」菜单
   *
   * 只管状态和 HTML，谁把它挂到弹窗上由 app.js 决定——
   * 跟"加一条"的表单是同一套分工。
   * ------------------------------------------------------------------- */

  var menu = null;       // { key, id }
  var moveDraft = null;  // { key, id, toKey }

  function openMenu(state, key, id) {
    if (!find(state, key, id)) return null;
    menu = { key: key, id: id };
    moveDraft = null;
    return menu;
  }
  function currentMenu() { return menu; }
  function closeMenu() { menu = null; moveDraft = null; }
  function openMovePanel() { if (menu) moveDraft = { key: menu.key, id: menu.id }; }
  function currentMove() { return moveDraft; }

  function menuHtml(state, tk) {
    if (!menu) return '';
    var t = find(state, menu.key, menu.id);
    if (!t) return '';
    var sid = seriesIdOf(t);
    var future = sid ? futureMembers(state, sid, tk) : [];
    var todoFuture = future.filter(function (m) { return m.task.status === 'todo'; });
    var attrs = ' data-date="' + esc(menu.key) + '" data-task="' + esc(t.id) + '"';
    var rows = [];

    rows.push('<button class="menu-item" data-act="m-edit"' + attrs + '>编辑这一条' +
      '<small>标题、科目、预计时长、备注、子任务都能改</small></button>');
    if (future.length > 1) {
      rows.push('<button class="menu-item" data-act="m-edit-series"' + attrs + '>改这一串' +
        '<small>这一串里还没打卡的 ' + todoFuture.length + ' 条一起改，已打卡的不动</small></button>');
    }
    if (t.status === 'todo') {
      rows.push('<button class="menu-item" data-act="m-move-open"' + attrs + '>改到别的日子' +
        '<small>今天 / 明天 / 后天，或者自己挑一天</small></button>');
    }
    rows.push('<button class="menu-item" data-act="m-copy"' + attrs + '>复制一条' +
      '<small>同一天再加一份一样的</small></button>');
    rows.push('<div class="menu-split">' +
        '<button class="menu-item" data-act="m-up"' + attrs + '>上移</button>' +
        '<button class="menu-item" data-act="m-down"' + attrs + '>下移</button>' +
      '</div>');
    if (todoFuture.length) {
      rows.push('<button class="menu-item danger" data-act="m-series-del"' + attrs + '>以后都删掉' +
        '<small>' + todoFuture.length + ' 条还没打卡的一起删，已经打卡的不动</small></button>');
    }
    rows.push('<button class="menu-item danger" data-act="m-del"' + attrs + '>删除这一条</button>');

    return '<div class="modal" style="max-width:400px">' +
      '<div class="modal-title">' + esc(t.title) + '</div>' +
      '<div class="menu-list">' + rows.join('') + '</div>' +
      '<button class="btn block ghost" style="margin-top:12px" data-act="m-menu-close">取消</button>' +
    '</div>';
  }

  function moveHtml(state, tk) {
    if (!moveDraft) return '';
    var t = find(state, moveDraft.key, moveDraft.id);
    if (!t) return '';
    var base = E.parseKey(tk);
    var quick = [[0, '今天'], [1, '明天'], [2, '后天']].map(function (pair) {
      var k = E.toKey(E.addDays(base, pair[0]));
      return '<button class="chip' + (k === moveDraft.key ? ' on' : '') +
        '" data-act="m-move-to" data-v="' + esc(k) + '">' + pair[1] +
        '<small>' + fmtDate(k) + '</small></button>';
    }).join('');

    return '<div class="modal" style="max-width:400px">' +
      '<div class="modal-title">改到哪一天？</div>' +
      '<div class="modal-msg">「' + esc(t.title) + '」现在是 ' + fmtDate(moveDraft.key) +
        ' 的。换一天不会动它的打卡和专注记录。</div>' +
      '<div class="chips" style="margin-top:14px">' + quick + '</div>' +
      '<div class="mf-block"><label>或选一天</label>' +
        '<div class="mf-subrow">' +
          '<input class="input" type="date" id="move-date" value="' + esc(moveDraft.key) + '">' +
          '<button class="btn sm primary" data-act="m-move-pick">就这天</button>' +
        '</div>' +
      '</div>' +
      '<button class="btn block ghost" style="margin-top:14px" data-act="m-menu-close">取消</button>' +
    '</div>';
  }

  /* ---------------------------------------------------------------------
   * 批量排
   *
   * 选科目 + 每周哪几天 + 每天多少 + 持续几周，然后往那些天里写普通清单条目。
   * 写出来的就是普通条目：能改、能删、能打卡，跟一条条手动加没有区别。
   * ------------------------------------------------------------------- */

  var batch = null;
  var WD_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

  function openBatch(state) {
    batch = { tagId: '', weekdays: [1, 2, 3, 4, 5], amount: 1, unit: 'sets', weeks: 4 };
    return batch;
  }
  function currentBatch() { return batch; }
  function closeBatch() { batch = null; }
  function setBatchField(k, v) { if (batch) batch[k] = v; }
  function toggleBatchDay(d) {
    if (!batch) return;
    var i = batch.weekdays.indexOf(d);
    if (i === -1) batch.weekdays.push(d);
    else batch.weekdays.splice(i, 1);
    batch.weekdays.sort(function (a, b) { return a - b; });
  }

  /* 这个标签"一道题大概几分钟"。自定义标签不在系统模块表里，给个保守值。 */
  function unitMinutesOf(state, tagId) {
    var m = YT.MODULE_BY_ID && YT.MODULE_BY_ID[YT.tagIdOf(tagId)];
    if (!m) return 1.5;
    return YT.unitMinutesFor(m, 'base', state.profile) || m.unitMinutes || 1.5;
  }

  /* 这一批会落在哪些天。休息日直接跳过——不提醒、不拦，就是不排。 */
  function batchDays(state, tk) {
    if (!batch || !batch.tagId) return [];
    var weeks = Math.min(Math.max(1, Number(batch.weeks) || 1), 12);
    var out = [], d = E.parseKey(tk);
    for (var i = 0; i < weeks * 7; i++) {
      var k = E.toKey(d);
      if (batch.weekdays.indexOf(d.getDay()) !== -1 && !E.isRest(d, state.profile)) out.push(k);
      d = E.addDays(d, 1);
    }
    return out;
  }

  function batchWork(state) {
    var n = Math.max(0.5, Math.round((Number(batch.amount) || 1) * 2) / 2);
    var per = unitMinutesOf(state, batch.tagId);
    var m = YT.MODULE_BY_ID && YT.MODULE_BY_ID[YT.tagIdOf(batch.tagId)];
    var setSize = (m && m.setSize) || 20;
    if (batch.unit === 'units') {
      return { work: { units: n }, minutes: Math.round(n * E.effectiveLesson(state.profile)) };
    }
    if (batch.unit === 'amount') {
      return { work: { amount: n }, minutes: Math.round(n * per) };
    }
    return { work: { sets: n }, minutes: Math.round(n * setSize * per) };
  }

  function batchHtml(state, tk) {
    if (!batch) return '';
    var names = tags(state).map(function (s) {
      return '<button class="chip' + (batch.tagId === s.id ? ' on' : '') +
        '" data-act="m-batch-tag" data-v="' + esc(s.id) + '">' + esc(s.name) + '</button>';
    }).join('');
    var dows = [1, 2, 3, 4, 5, 6, 0].map(function (d) {
      return '<button class="chip' + (batch.weekdays.indexOf(d) !== -1 ? ' on' : '') +
        '" data-act="m-batch-wd" data-v="' + d + '">' + WD_NAMES[d] + '</button>';
    }).join('');
    var units = [['sets', '组'], ['amount', '题'], ['units', '节']].map(function (p) {
      return '<button class="chip' + (batch.unit === p[0] ? ' on' : '') +
        '" data-act="m-batch-unit" data-v="' + p[0] + '">' + p[1] + '</button>';
    }).join('');

    var days = batchDays(state, tk);
    var w = batch.tagId ? batchWork(state) : null;
    var preview = days.length
      ? '会排 <b>' + days.length + '</b> 条，从 ' + fmtDate(days[0]) + ' 到 ' + fmtDate(days[days.length - 1]) +
        '，每条约 <b>' + fmtMinutes(w.minutes) + '</b>。'
      : '先选一个科目。';

    return '<div class="modal" style="max-width:420px">' +
      '<div class="modal-title">批量排</div>' +
      '<div class="modal-msg">一次排好几周的固定安排，休息日自动跳过。</div>' +
      '<div class="mf-block"><label>科目</label><div class="chips">' + names + '</div></div>' +
      '<div class="mf-block"><label>每周哪几天</label><div class="chips">' + dows + '</div></div>' +
      '<div class="mf-block"><label>每天多少</label><div class="chips">' +
        '<input class="mf-mins" type="number" min="0.5" step="0.5" inputmode="decimal" ' +
          'data-act="m-batch-num" data-k="amount" value="' + batch.amount + '">' + units +
      '</div></div>' +
      '<div class="mf-block"><label>持续几周</label><div class="chips">' +
        '<input class="mf-mins" type="number" min="1" max="12" step="1" inputmode="numeric" ' +
          'data-act="m-batch-num" data-k="weeks" value="' + batch.weeks + '"><span class="mf-hint">周</span>' +
      '</div></div>' +
      '<div class="mf-hint" id="batch-preview" style="margin-top:12px;line-height:1.7">' + preview + '</div>' +
      '<div class="row" style="gap:8px;margin-top:16px">' +
        '<button class="btn grow ghost" data-act="m-batch-close">取消</button>' +
        '<button class="btn grow primary" data-act="m-batch-apply">排进去</button>' +
      '</div>' +
    '</div>';
  }

  /* 真正写进去。返回 {made, over}：
   *   made —— 排了几条
   *   over —— 其中几天排完超过了当天目标（只提示，不拦） */
  function applyBatchNow(state, tk) {
    if (!batch || !batch.tagId) return null;
    var days = batchDays(state, tk);
    if (!days.length) return null;
    var w = batchWork(state);
    var label = subjectLabel(state, batch.tagId);
    var made = 0, over = 0;
    days.forEach(function (k) {
      add(state, k, {
        title: label,
        moduleId: batch.tagId,
        minutes: w.minutes,
        work: w.work,
        note: '',
      });
      made++;
      var total = 0;
      ((state.days[k] || {}).tasks || []).forEach(function (t) { total += Number(t.minutes) || 0; });
      var target = dailyTarget(state, k);
      if (target && total > target) over++;
    });
    batch = null;
    return { made: made, over: over };
  }

  function remove(state, key, id) {
    var day = state.days[key];
    if (!day) return false;
    var n = day.tasks.length;
    day.tasks = day.tasks.filter(function (t) { return t.id !== id; });
    if (!day.tasks.length) {
      delete state.days[key];
      return true;
    }
    renumber(day);
    return day.tasks.length !== n;
  }

  /* 两态打卡：完成 / 未完成 */
  function toggleDone(state, key, id) {
    var t = find(state, key, id);
    if (!t) return null;
    t.status = t.status === 'done' ? 'todo' : 'done';
    if (t.status !== 'done') { t.actualMinutes = null; }
    t.log = t.log || [];
    t.log.push({ at: new Date().toISOString(), status: t.status });
    if (t.log.length > 20) t.log = t.log.slice(-20);
    return t;
  }

  function toggleSub(state, key, id, subId) {
    var t = find(state, key, id);
    if (!t || !Array.isArray(t.subtasks)) return null;
    var s = t.subtasks.filter(function (x) { return x.id === subId; })[0];
    if (!s) return null;
    s.done = !s.done;
    return t;
  }

  function renumber(day) {
    ordered(day).forEach(function (t, i) { t.order = i + 1; });
  }

  function move(state, key, id, dir) {
    var day = state.days[key];
    if (!day) return false;
    var list = ordered(day);
    var i = -1;
    list.forEach(function (t, idx) { if (t.id === id) i = idx; });
    var j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return false;
    var tmp = list[i].order;
    list[i].order = list[j].order;
    list[j].order = tmp;
    /* order 相同时（老数据）直接按数组位置换一下也行 */
    if (list[i].order === list[j].order) {
      var arr = day.tasks;
      var ai = arr.indexOf(list[i]), aj = arr.indexOf(list[j]);
      arr[ai] = list[j]; arr[aj] = list[i];
    }
    renumber(day);
    return true;
  }

  function setSubtask(state, key, id, list) {
    var t = find(state, key, id);
    if (!t) return false;
    t.subtasks = list.map(function (s) { return { id: uid('s-'), title: String(s.title || ''), done: !!s.done }; });
    return true;
  }

  /* ---------------------------------------------------------------------
   * 模式切换：系统任务 → 清单项
   * ------------------------------------------------------------------- */

  function hasContent(state) {
    var keys = Object.keys(state.days || {});
    for (var i = 0; i < keys.length; i++) {
      if ((state.days[keys[i]].tasks || []).length) return true;
    }
    return false;
  }

  /* 保留：旧任务一律当"用户自己写的"处理，系统永不覆盖。 */
  function keepAsChecklist(state) {
    var n = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      var day = state.days[k];
      if (!day) return;
      var list = day.tasks || [];
      list.forEach(function (t) {
        normalize(t);
        t.userAdded = true;
        t.skip = false;
        delete t.skipAt;
        if (t.status === 'half') t.status = 'todo';
        if (typeof t.order !== 'number') { n++; t.order = n; }
      });
      renumber(day);
    });
    settings(state);
    return n;
  }

  /* 清空：删掉所有任务记录，从头开始。专注记录留着——那是真花过的时间。 */
  function clearAll(state) {
    state.days = {};
    state.forecast = null;
    state.cutPlan = null;
    state.weekMark = {};
    state.adjustLog = [];
    state.weeklyLog = [];
  }

  /* ---------------------------------------------------------------------
   * 表单草稿
   * ------------------------------------------------------------------- */

  var draft = null;

  function blankDraft(date) {
    return {
      mode: 'add',          // 'add' | 'edit'
      date: date || null,
      key: date || null,    // 编辑时用：正在改的那一条在哪一天
      id: null,             // 编辑时用：正在改的那一条的 id
      fields: { title: '', titleTouched: false, moduleId: '', minutes: '', note: '',
                subtasks: [], repeatFreq: '', repeatUntil: '', remindTime: '' },
      newTag: null,   // 「＋新建标签」时的临时输入框内容
    };
  }

  function openAdd(state, date) {
    draft = blankDraft(date);
    /* 开了子任务就先给一行空的，省得用户还要先点一次「＋」。 */
    if (settings(state).advanced.subtask) draft.fields.subtasks = [''];
    return draft;
  }

  /* 把一条现有的清单项读进草稿，表单进编辑态。
   * 只读"用户能改的字段"——status / actualMinutes / focusMinutes / order /
   * createdAt 一律不进草稿，保存时也就没机会被覆盖。 */
  function openEdit(state, key, id, opts) {
    var t = find(state, key, id);
    if (!t) return null;
    normalize(t);
    var adv = settings(state).advanced;
    draft = blankDraft(key);
    draft.mode = 'edit';
    draft.key = key;
    draft.id = id;
    /* scope='series'：从「改这一串」进来的，保存时不再问，直接改整串。 */
    draft.scope = (opts && opts.scope) || null;
    draft.fields.title = t.title || '';
    draft.fields.titleTouched = true;   // 已经定过的标题，不再跟着标签走
    draft.fields.moduleId = t.moduleId || '';
    draft.fields.minutes = t.minutes ? String(t.minutes) : '';
    draft.fields.note = t.note || '';
    draft.fields.subtasks = (t.subtasks || []).map(function (s) { return s.title; });
    draft.fields.repeatFreq = (t.repeat && t.repeat.freq) || '';
    draft.fields.repeatUntil = (t.repeat && t.repeat.until) || '';
    draft.fields.remindTime = (t.remind && t.remind.time) || '';
    if (adv.subtask && !draft.fields.subtasks.length) draft.fields.subtasks = [''];
    return draft;
  }

  function closeAdd() { draft = null; }
  function currentDraft() { return draft; }
  function setDraft(k, v) { if (draft) draft.fields[k] = v; }
  function setDraftScope(v) { if (draft) draft.scope = v || null; }
  /* 标题单独走这条路：一旦手动改过，就不再被科目标签自动覆盖。 */
  function setTitle(v) {
    if (!draft) return;
    draft.fields.title = v;
    draft.fields.titleTouched = true;
  }
  function setSub(i, v) {
    if (!draft || !Array.isArray(draft.fields.subtasks)) return;
    draft.fields.subtasks[i] = v;
  }
  function addSub() {
    if (!draft) return;
    if (!Array.isArray(draft.fields.subtasks)) draft.fields.subtasks = [];
    draft.fields.subtasks.push('');
  }
  function delSub(i) {
    if (!draft || !Array.isArray(draft.fields.subtasks)) return;
    draft.fields.subtasks.splice(i, 1);
  }

  /* ---- 「＋新建标签」的临时输入 ---- */
  function startNewTag() { if (draft) draft.newTag = ''; }
  function cancelNewTag() { if (draft) draft.newTag = null; }
  function setNewTag(v) { if (draft) draft.newTag = v; }
  /* 建好标签并选上；标题没被手改过就跟着标签走。 */
  function commitNewTag(state) {
    if (!draft) return null;
    var t = addTag(state, draft.newTag);
    if (!t) return null;
    draft.fields.moduleId = t.id;
    if (!draft.fields.titleTouched) draft.fields.title = t.name;
    draft.newTag = null;
    return t;
  }
  function setMinutes(v) { if (draft) draft.fields.minutes = v; }

  /* 提交表单：返回 {ok, msg, added} */
  function commitAdd(state) {
    if (!draft) return { ok: false, msg: '表单已经关掉了' };
    var f = draft.fields;
    /* 只有「不指定科目」才必须自己写标题；选了科目，留空就用科目名。 */
    var title = String(f.title || '').trim() || subjectLabel(state, f.moduleId);
    if (!title) return { ok: false, msg: '先写个标题' };

    var adv = settings(state).advanced;

    var subtasks = [];
    if (adv.subtask && Array.isArray(f.subtasks)) {
      subtasks = f.subtasks.map(function (s) {
        return { title: String(s || '').trim() };
      }).filter(function (s) { return s.title; });
    }

    var repeat = null;
    if (adv.repeat && f.repeatFreq) {
      repeat = { freq: f.repeatFreq, until: f.repeatUntil || '' };
    }

    var remind = null;
    if (adv.remind && f.remindTime) remind = { on: true, time: f.remindTime };

    var res = add(state, draft.date, {
      title: title,
      moduleId: f.moduleId || null,
      minutes: Number(f.minutes) || 0,
      note: String(f.note || '').trim(),
      subtasks: subtasks,
      repeat: repeat,
      remind: remind,
    });
    draft = null;
    if (!res) return { ok: false, msg: '这天加不进去' };
    return { ok: true, added: 1 + (res.extra || 0) };
  }

  /* 草稿里"用户填的那部分" → 一份可复用的改动。add 和 edit 共用同一套规则。 */
  function patchFromDraft(state) {
    var f = draft.fields;
    var adv = settings(state).advanced;
    var title = String(f.title || '').trim() || subjectLabel(state, f.moduleId);
    if (!title) return { ok: false, msg: '先写个标题' };

    var subtasks = [];
    if (adv.subtask && Array.isArray(f.subtasks)) {
      subtasks = f.subtasks.map(function (s) { return String(s || '').trim(); })
        .filter(function (s) { return s; });
    }

    var repeat = null;
    if (adv.repeat && f.repeatFreq) repeat = { freq: f.repeatFreq, until: f.repeatUntil || '' };

    var remind = null;
    if (adv.remind && f.remindTime) remind = { on: true, time: f.remindTime };

    return {
      ok: true,
      patch: {
        title: title,
        moduleId: f.moduleId || null,
        moduleName: f.moduleId ? subjectLabel(state, f.moduleId) : '',
        minutes: Math.max(0, Math.round(Number(f.minutes) || 0)),
        note: String(f.note || '').trim(),
        subtaskTitles: subtasks,
        /* 关着的开关不该在保存时把已有的东西抹掉：这几项只在开关打开时才写回。 */
        touchSubtasks: !!adv.subtask,
        touchRepeat: !!adv.repeat,
        touchRemind: !!adv.remind,
        repeat: repeat,
        remind: remind,
      },
    };
  }

  /* 子任务重建：同名的沿用原来的 id 和勾选状态，新名字才新建。
   * 用户改标题时不会把已经勾掉的步骤弄丢。 */
  function rebuildSubtasks(oldList, titles) {
    var used = [];
    return (titles || []).map(function (title) {
      var found = null;
      (oldList || []).forEach(function (s) {
        if (found || used.indexOf(s) !== -1) return;
        if (String(s.title) === title) found = s;
      });
      if (found) {
        used.push(found);
        return { id: found.id, title: title, done: !!found.done };
      }
      return { id: uid('s-'), title: title, done: false };
    });
  }

  /* 把 patch 写进一条任务。order / status / actualMinutes / focusMinutes /
   * createdAt / id / seriesId 一律不碰。 */
  function applyPatch(t, patch) {
    t.title = patch.title;
    t.moduleId = patch.moduleId;
    t.moduleName = patch.moduleName || '';
    t.minutes = patch.minutes;
    t.note = patch.note;
    /* adv 开关关着的那一项保持原样——用户没在表单里看到它，就不该被它改掉。 */
    if (patch.touchSubtasks) t.subtasks = rebuildSubtasks(t.subtasks, patch.subtaskTitles);
    if (patch.touchRepeat) t.repeat = patch.repeat;
    if (patch.touchRemind) t.remind = patch.remind;
  }

  /* 保存编辑。返回：
   *   {ok:true, task}                      —— 改好了
   *   {ok:false, msg}                      —— 不行
   *   {ok:false, needScope:true, count:N}  —— 这一条属于一个重复串，先问一句改一条还是改一串
   */
  function commitEdit(state, tk) {
    if (!draft || draft.mode !== 'edit') return { ok: false, msg: '没有正在改的条目' };
    var t = find(state, draft.key, draft.id);
    if (!t) return { ok: false, msg: '这条找不到了' };
    var res = patchFromDraft(state);
    if (!res.ok) return res;

    var sid = seriesIdOf(t);
    var future = sid ? futureMembers(state, sid, tk) : [];
    var scope = draft.scope || null;
    if (sid && future.length > 1 && !scope) {
      return { ok: false, needScope: true, count: future.length };
    }

    if (scope === 'series') {
      /* 改一串：今天及以后、还没打卡的条目全部同步；已打卡的一律不动。 */
      var n = 0;
      future.forEach(function (m) {
        if (m.task.status !== 'todo') return;
        applyPatch(m.task, res.patch);
        n++;
      });
      draft = null;
      return { ok: true, task: t, touched: n };
    }

    applyPatch(t, res.patch);
    draft = null;
    return { ok: true, task: t, touched: 1 };
  }

  /* ---------------------------------------------------------------------
   * 渲染：一条清单项
   * ------------------------------------------------------------------- */

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.6l4.2 4.2 8.8-9.6"/></svg>';

  function cardHtml(state, t, key, isToday) {
    normalize(t);
    var done = t.status === 'done';
    var subs = t.subtasks || [];
    var subStat = subtaskStat(t);
    var focus = Number(t.focusMinutes) || 0;

    var pills = [];
    var sub = subjectName(state, t);
    if (sub) pills.push('<span class="pill plain">' + esc(sub) + '</span>');
    var wt = workText(t);
    if (wt) pills.push('<span class="pill plain">' + esc(wt) + '</span>');
    if (subStat.total) pills.push('<span class="pill plain m-subcnt">' + subStat.done + '/' + subStat.total + '</span>');
    /* 重复串：写清是什么节奏、后面还剩几条，不然"重复"两个字什么也没说。 */
    if (seriesIdOf(t)) {
      var sid0 = seriesIdOf(t);
      /* 以这张卡所在的这一天为起点数，演示模式跳到别的日期也准。 */
      var left0 = futureMembers(state, sid0, key).length;
      pills.push('<span class="pill plain">' + esc(seriesLabel(t)) +
        (left0 > 1 ? ' · 还有 ' + (left0 - 1) + ' 条' : '') + '</span>');
    }
    /* 预计时长够长时给一句番茄数换算：45 分钟 ≈ 2 个番茄。 */
    if (!done && (Number(t.minutes) || 0) >= 30) {
      var focusWork = (YT.focus && YT.focus.settings) ? YT.focus.settings(state).work : 25;
      var pomo = Math.max(1, Math.round((Number(t.minutes) || 0) / focusWork));
      pills.push('<span class="pill plain">约 ' + pomo + ' 个番茄</span>');
    }
    /* 完成之后：显示"实际用了多久"，点一下能重开弹窗改。 */
    if (isToday && done) {
      var eff = YT.stats.effectiveMinutes(t);
      pills.push('<button class="pill plain m-actual" data-act="m-actual-open" ' +
        'data-date="' + esc(key) + '" data-task="' + esc(t.id) + '">' +
        (eff > 0 ? ('实际 ' + fmtMinutes(eff) + ' · 改') : '补记实际用时') + '</button>');
    } else if (focus > 0) {
      pills.push('<span class="pill plain">已专注 ' + focus + ' 分</span>');
    }

    var subsHtml = subs.length
      ? '<div class="m-subs">' + subs.map(function (s) {
          return '<button class="m-sub' + (s.done ? ' on' : '') + '" data-act="m-sub" ' +
            'data-date="' + esc(key) + '" data-task="' + esc(t.id) + '" data-sub="' + esc(s.id) + '">' +
            '<span class="m-sub-box">' + (s.done ? CHECK_SVG : '') + '</span>' +
            '<span class="m-sub-t">' + esc(s.title) + '</span></button>';
        }).join('') + '</div>'
      : '';

    /* 打卡和开始专注只在今天：别的日子给一个静态状态点，
     * 能看、能排、能删，就是不能打卡也不能开跑。 */
    var tickHtml = isToday
      ? '<button class="tick ' + (done ? 'done' : '') + '" data-act="m-done" ' +
          'data-date="' + esc(key) + '" data-task="' + esc(t.id) + '" aria-label="打卡"></button>'
      : '<span class="tick locked ' + (done ? 'done' : '') + '" role="img" ' +
          'aria-label="' + (done ? '已完成' : '未完成') + '"></span>';
    var topAttr = isToday
      ? ' data-act="m-done" data-date="' + esc(key) + '" data-task="' + esc(t.id) + '"'
      : '';
    /* 做完的事就别再喊"开始专注"了；卡片右下角只留一个入口，
     * 上移下移删除改期全部收进「⋯」，一屏里少掉三排小按钮。 */
    var focusHtml = (isToday && !done)
      ? '<button class="m-act" data-act="m-focus" data-date="' + esc(key) + '" data-task="' + esc(t.id) + '">' +
          '<span class="m-act-dot"></span>开始专注</button>'
      : '';

    return '<div class="task m-task' + (done ? ' is-done' : '') + '">' +
      tickHtml +
      '<div class="task-body">' +
        '<div class="task-top"' + topAttr + '>' +
          '<span class="task-title">' + esc(t.title) + '</span>' +
          (t.minutes ? '<span class="task-min">' + fmtMinutes(t.minutes) + '</span>' : '') +
          '<button class="m-ico m-more" data-act="m-menu" data-date="' + esc(key) + '" data-task="' + esc(t.id) + '" aria-label="更多操作">⋯</button>' +
        '</div>' +
        (t.note ? '<div class="task-detail">' + esc(t.note) + '</div>' : '') +
        (pills.length ? '<div class="task-meta">' + pills.join('') + '</div>' : '') +
        subsHtml +
        (focusHtml ? '<div class="m-actions">' + focusHtml + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  /* ---------------------------------------------------------------------
   * 渲染：加一条的表单
   * ------------------------------------------------------------------- */

  /* 「加一条」和「改这一条」是同一张表单，只有标题和那个主按钮不一样。
   * 这样加和改的字段永远一致，不会出现"加的时候能填、改的时候改不了"。 */
  function formWrapHtml(state, title, saveAct, saveLabel) {
    if (!draft) return '';
    var f = draft.fields;
    var adv = settings(state).advanced;
    var mid = f.moduleId;

    /* 标签行：不指定 + 预设 + 自定义 + 「＋新建」。 */
    var subjChips = '<button class="chip ' + (mid === '' ? 'on' : '') + '" data-act="m-f-subject" data-v="">不指定</button>' +
      tags(state).map(function (s) {
        return '<button class="chip ' + (mid === s.id ? 'on' : '') + '" data-act="m-f-subject" data-v="' + esc(s.id) + '">' + esc(s.name) + '</button>';
      }).join('') +
      '<button class="chip mf-newtag' + (draft.newTag !== null ? ' on' : '') + '" data-act="m-tag-new">＋ 新建</button>';

    /* 点「＋新建」后展开的输入行 */
    var newTagRow = (draft.newTag === null) ? '' :
      '<div class="mf-subrow" style="margin-top:8px">' +
        '<input class="input" type="text" data-act="m-tag-input" maxlength="8" ' +
          'placeholder="新标签名（最多 8 字）" value="' + esc(draft.newTag || '') + '">' +
        '<button class="m-ico" data-act="m-tag-save" aria-label="建好这个标签">✓</button>' +
        '<button class="m-ico danger" data-act="m-tag-cancel" aria-label="取消">×</button>' +
      '</div>';

    /* 预计时长：选填，但给档位快选（时间是唯一量化口径）。 */
    var minuteChips = [15, 30, 60, 120].map(function (v) {
      return '<button class="chip ' + (String(f.minutes) === String(v) ? 'on' : '') +
        '" data-act="m-f-minutes" data-v="' + v + '">' + v + ' 分</button>';
    }).join('');

    /* 子任务：可加减的行，一行一个，不再让用户自己换行拼字符串。 */
    var subRows = '';
    if (adv.subtask) {
      var rows = (Array.isArray(f.subtasks) && f.subtasks.length) ? f.subtasks : [''];
      subRows = '<div class="mf-block"><label>子任务</label>' +
        rows.map(function (v, i) {
          return '<div class="mf-subrow">' +
            '<input class="input" type="text" data-act="m-f-sub" data-i="' + i + '" ' +
              'placeholder="第 ' + (i + 1) + ' 条" value="' + esc(v) + '">' +
            '<button class="m-ico danger" data-act="m-sub-del" data-i="' + i + '" aria-label="删掉这条子任务">×</button>' +
          '</div>';
        }).join('') +
        '<button class="mf-add" data-act="m-sub-add">＋ 添加子任务</button>' +
      '</div>';
    }

    var extra = '';
    if (adv.repeat) {
      extra += '<div class="mf-block"><label>重复</label>' +
        '<div class="chips">' +
          ['daily:每天', 'weekdays:工作日', 'weekly:每周'].map(function (pair) {
            var k = pair.split(':')[0], label = pair.split(':')[1];
            return '<button class="chip ' + (f.repeatFreq === k ? 'on' : '') + '" data-act="m-f-repeat" data-v="' + k + '">' + label + '</button>';
          }).join('') +
        '</div>' +
        (f.repeatFreq
          ? '<div class="mf-row" style="margin-top:8px"><label>到</label>' +
            '<input class="input" type="date" data-act="m-f" data-k="repeatUntil" value="' + esc(f.repeatUntil) + '">' +
            '<span class="mf-hint">不填就展开一个月</span></div>'
          : '') +
        '</div>';
    }
    if (adv.remind) {
      extra += '<div class="mf-block"><label>提醒</label>' +
        '<input class="input" type="time" data-act="m-f" data-k="remindTime" value="' + esc(f.remindTime) + '">' +
        '<div class="mf-hint">本期只预留了接口，不会真的推送——网页在后台到点提醒不可靠，等上线前再接。</div></div>';
    }

    /* 关掉的高级项在这里只留一句入口；开关本身只有「设置 → 清单选项」一处。 */
    var offNames = [];
    if (!adv.subtask) offNames.push('子任务');
    if (!adv.repeat) offNames.push('重复');
    if (!adv.remind) offNames.push('提醒');
    var moreHint = offNames.length
      ? '<button class="mf-more" data-act="m-f-adv-open">' + offNames.join(' / ') +
        '：在「我的 → 设置 → 清单选项」里开启</button>'
      : '';

    var titlePlaceholder = mid ? ('留空就用「' + subjectLabel(state, mid) + '」') : '必填：要做什么？';

    return '<div class="m-form' + (draft.mode === 'edit' ? ' editing' : '') + '">' +
      '<div class="mf-title">' + esc(title) + '</div>' +
      '<input class="input" type="text" data-act="m-f" data-k="title" placeholder="' + esc(titlePlaceholder) + '" value="' + esc(f.title) + '">' +
      '<div class="mf-block"><label>科目标签</label><div class="chips">' + subjChips + '</div>' + newTagRow + '</div>' +
      '<div class="mf-block"><label>预计时长</label>' +
        '<div class="chips">' + minuteChips +
          '<input class="mf-mins" type="number" min="0" max="480" step="5" inputmode="numeric" ' +
            'data-act="m-f" data-k="minutes" placeholder="自己填" value="' + esc(f.minutes) + '">' +
          '<span class="mf-hint" style="align-self:center">分钟</span></div>' +
        '<div class="mf-hint">只用来算"今天排了多少"；真正学了多久由计时器和完成时确认。</div>' +
      '</div>' +
      '<input class="input" type="text" data-act="m-f" data-k="note" placeholder="备注（可不填）" value="' + esc(f.note) + '">' +
      subRows + extra + moreHint +
      '<div class="row" style="gap:8px;margin-top:14px">' +
        '<button class="btn grow ghost" data-act="m-add-cancel">取消</button>' +
        '<button class="btn grow primary" data-act="' + saveAct + '">' + esc(saveLabel) + '</button>' +
      '</div>' +
    '</div>';
  }

  /* 新增：只有"加一条"这一态才在当天底部露出来 */
  function addFormHtml(state, date) {
    if (!draft || draft.mode !== 'add' || draft.date !== date) return '';
    return formWrapHtml(state, '加一条', 'm-add-save', '加进来');
  }

  /* 编辑：渲染在那张卡片原来的位置上 */
  function editFormHtml(state, key) {
    if (!draft || draft.mode !== 'edit' || draft.key !== key) return '';
    return formWrapHtml(state, '改这一条', 'm-edit-save', '保存');
  }

  /* 一天里，正在编辑的那一条换成表单，其余照旧。 */
  function taskListHtml(state, tasks, key, isToday, emptyHtml) {
    if (!tasks.length) return emptyHtml || '';
    return tasks.map(function (t) {
      if (draft && draft.mode === 'edit' && draft.key === key && draft.id === t.id) {
        return editFormHtml(state, key);
      }
      return cardHtml(state, t, key, isToday);
    }).join('');
  }

  /* ---------------------------------------------------------------------
   * 渲染：今日
   * ------------------------------------------------------------------- */

  function todayHtml(state, tk) {
    var day = state.days[tk];
    var tasks = day ? ordered(day) : [];
    var done = tasks.filter(function (t) { return t.status === 'done'; }).length;
    var focus = YT.stats.focusToday(state, tk);
    var st = YT.stats.streak(state, tk);
    var toExam = state.profile.examDate ? E.dayDiff(tk, state.profile.examDate) : null;
    var isRest = !!(day && day.isRest) ||
      (!day && E.isRest(E.parseKey(tk), state.profile));

    /* 「今天排了多久」：只统计用户自己填了预计时长的那部分。
     * 一条都没填就整行不出现——那时候显示"排了 0 分钟"是句假话，
     * 显示目标更像在催账。 */
    var planned = 0;
    tasks.forEach(function (t) { planned += Number(t.minutes) || 0; });
    var target = dailyTarget(state, tk);
    var totalLine = planned > 0
      ? '<div class="today-total' + (target && planned > target ? ' over' : '') + '">今天排了 <b>' + fmtMinutes(planned) + '</b>' +
          (target ? ' · 目标 ' + fmtMinutes(target) : '') + '</div>'
      : '';

    var head = '<div class="today-head">' +
      '<div class="date">' + fmtDate(tk) + '　' + weekdayName(tk) + '</div>' +
      '<h1>' + (isRest && !tasks.length ? '今天休息' : '今天') + '</h1>' +
      '<div class="state">' +
        (tasks.length
          ? '清单 <b>' + done + ' / ' + tasks.length + '</b> 项'
          : (isRest ? '休息日 · 想学就自己加，不拦着' : '清单是空的，想做什么自己加')) +
        (focus.minutes ? ' · 今天专注 <b>' + focus.minutes + '</b> 分钟' : '') +
        (focus.pomodoros ? ' · <b>' + focus.pomodoros + '</b> 个番茄' : '') +
        (toExam !== null && toExam >= 0 ? ' · 距考试 <b>' + toExam + '</b> 天' : '') +
        (st > 1 ? ' · 连续 <b>' + st + '</b> 天' : '') +
      '</div>' +
      totalLine +
    '</div>';

    var listHtml = taskListHtml(state, tasks, tk, true,
      '<div class="m-empty">今天还没有安排。<br>点下面「加一条」，把想做的事写进来。</div>');

    var formHtml = addFormHtml(state, tk);
    var adding = !!(draft && draft.mode === 'add' && draft.date === tk);

    return head +
      '<div class="section"><div class="card tasks">' + listHtml + '</div></div>' +
      '<div class="section">' +
        (adding
          ? ''
          : '<div class="row" style="gap:8px">' +
              '<button class="btn grow secondary" data-act="m-add-open" data-v="' + esc(tk) + '">加一条</button>' +
              '<button class="btn grow primary" data-act="m-focus-open" data-v="' + esc(tk) + '">开始专注</button>' +
            '</div>') +
        formHtml +
      '</div>' +
      focusHighlightsHtml(state, tk);
  }

  /* 事实型正反馈。放在今日页最底下，看完一天的清单才看得到。 */
  function focusHighlightsHtml(state, tk) {
    var list = YT.feedback ? YT.feedback.highlights(state, tk) : [];
    if (!list.length) return '';
    return '<div class="section"><p class="section-title">你做到的</p>' +
      '<div class="card">' +
        list.map(function (h) { return '<div class="fb-row">' + esc(h.text) + '</div>'; }).join('') +
      '</div></div>';
  }

  /* ---------------------------------------------------------------------
   * 渲染：月历（计划）
   * ------------------------------------------------------------------- */

  function monthKey(state, tk) { return state.ui.manMonth || tk.slice(0, 7); }

  function shiftMonth(mkey, delta) {
    var y = Number(mkey.slice(0, 4)), m = Number(mkey.slice(5, 7)) + delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return y + '-' + (m < 10 ? '0' + m : m);
  }

  function dayInfo(state, k) {
    var day = state.days[k];
    var tasks = day ? ordered(day) : [];
    var total = 0, focus = 0;
    tasks.forEach(function (t) { total += Number(t.minutes) || 0; });
    try {
      var ft = YT.stats.focusTotals(state, k);
      /* focusTotals(state, k) 给的是"到 k 为止"的累计，这里只要当天 */
      focus = (ft.byDay && ft.byDay[k]) || 0;
    } catch (e) { focus = 0; }
    /* 休息日只作视觉标记：有记录的日子以记录为准（在休息日加了任务就不算休息），
     * 没记录的日子按 profile.restDays 标出来。它不阻止加任务。 */
    var isRest = day ? !!day.isRest : E.isRest(E.parseKey(k), state.profile);
    return { day: day, tasks: tasks, total: total, focus: focus, isRest: isRest };
  }

  function planHtml(state, tk) {
    var view = (state.ui && state.ui.manPlanView === 'week') ? 'week' : 'month';
    var seg = '<div class="segmented" style="margin-bottom:12px">' +
        '<button class="' + (view === 'week' ? 'on' : '') + '" data-act="m-plan-view" data-v="week">本周</button>' +
        '<button class="' + (view === 'month' ? 'on' : '') + '" data-act="m-plan-view" data-v="month">日历</button>' +
      '</div>';
    var head = '<div class="top"><h1>我的计划</h1>' +
      '<div class="sub">' + (state.profile.examDate
        ? '距考试 ' + Math.max(0, E.dayDiff(tk, state.profile.examDate)) + ' 天 · '
        : '') + '内容全部由你自己安排</div>' +
      '<div class="row between" style="align-items:center;margin-top:12px">' +
        '<button class="pillbtn" data-act="m-batch-open">批量排 ›</button>' +
      '</div></div>' + seg;

    if (view === 'week') {
      return head + '<div class="section">' + weekListHtml(state, tk) + '</div>';
    }

    var mkey = monthKey(state, tk);
    var y = Number(mkey.slice(0, 4)), mo = Number(mkey.slice(5, 7));
    var firstD = new Date(y, mo - 1, 1);
    var lastD = new Date(y, mo, 0);
    var back = firstD.getDay() === 0 ? 6 : firstD.getDay() - 1;
    var gridStart = E.addDays(firstD, -back);
    var fwd = lastD.getDay() === 0 ? 0 : 7 - lastD.getDay();
    var gridEnd = E.addDays(lastD, fwd);

    /* 一个月里最长的那天当标尺，格子里的柱子才有可比性 */
    var maxTotal = 1, monthKeys = [];
    for (var dd = 1; dd <= lastD.getDate(); dd++) {
      var k0 = y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (dd < 10 ? '0' + dd : dd);
      monthKeys.push(k0);
      var info0 = dayInfo(state, k0);
      if (info0.total + info0.focus > maxTotal) maxTotal = info0.total + info0.focus;
    }

    var sel = state.ui.manDay || tk;
    if (monthKeys.indexOf(sel) === -1) sel = (tk.slice(0, 7) === mkey) ? tk : monthKeys[0];

    var heads = ['一', '二', '三', '四', '五', '六', '日']
      .map(function (w) { return '<div class="cal-head">' + w + '</div>'; }).join('');

    var cells = '';
    var d = gridStart, guard = 0;
    while (d <= gridEnd && guard < 45) {
      guard++;
      var k = E.toKey(d);
      if (d.getMonth() !== mo - 1) { cells += '<div class="cal-cell out"></div>'; d = E.addDays(d, 1); continue; }
      var info = dayInfo(state, k);
      var cls = 'cal-cell';
      if (info.isRest) cls += ' rest';
      if (k === tk) cls += ' today';
      if (state.ui.manDay === k) cls += ' sel';
      var total = info.total + info.focus;
      var ratio = info.isRest ? 0 : Math.max(6, Math.round(total / maxTotal * 100));
      var mini = info.tasks.length ? (info.tasks.length + '项' + (total ? ' · ' + Math.round(total / 6) / 10 + 'h' : '')) : (info.isRest ? '休' : '');
      cells += '<button class="' + cls + '" data-act="m-cal" data-v="' + k + '">' +
        '<span class="cal-d">' + d.getDate() + '</span>' +
        '<span class="cal-bar"><i style="height:' + ratio + '%"></i></span>' +
        '<span class="cal-mini">' + mini + '</span>' +
      '</button>';
      d = E.addDays(d, 1);
    }

    /* 能往后翻：往前随便看，往后最远到今天 +12 个月（或者考试那个月，谁近听谁的）。
     * 以前下个月是灰的，而"每天重复"会把条目铺到 60 天后——那些条目根本看不见。 */
    var maxMonth = maxPlanMonth(state, tk);
    var canNext = mkey < maxMonth;
    var monthBar = '<div class="row between" style="align-items:center;margin-bottom:8px">' +
      '<button class="ord-mv" data-act="m-month" data-v="-1" aria-label="上个月">←</button>' +
      '<span style="font-size:14px;font-weight:600">' + y + ' 年 ' + mo + ' 月</span>' +
      '<button class="ord-mv" data-act="m-month" data-v="1"' + (canNext ? '' : ' disabled') + ' aria-label="下个月">→</button>' +
    '</div>';

    return head +
      '<div class="section"><div class="card">' + monthBar +
        '<div class="cal-grid">' + heads + cells + '</div>' +
        '<div class="cal-detail">' + dayDetailHtml(state, sel, tk) + '</div>' +
      '</div></div>';
  }

  /* 计划页最远能翻到哪个月。 */
  function maxPlanMonth(state, tk) {
    var todayM = tk.slice(0, 7);
    var plus12 = shiftMonth(todayM, 12);
    var exam = state.profile && state.profile.examDate
      ? String(state.profile.examDate).slice(0, 7) : null;
    if (exam && exam > todayM && exam < plus12) return exam;
    return plus12;
  }

  /* 本周（今天起 7 天）竖排：一眼看全，适合"这周怎么安排"。
   * 日历那档适合看疏密，两档各干各的活。 */
  function weekListHtml(state, tk) {
    var out = '', d = E.parseKey(tk);
    for (var i = 0; i < 7; i++) {
      var k = E.toKey(d);
      var info = dayInfo(state, k);
      var done = info.tasks.filter(function (t) { return t.status === 'done'; }).length;
      var total = 0;
      info.tasks.forEach(function (t) { total += Number(t.minutes) || 0; });
      var right = info.tasks.length
        ? done + '/' + info.tasks.length + ' 项' + (total ? ' · ' + fmtMinutes(total) : '')
        : (info.isRest ? '休息' : '空');
      out += '<div class="m-wd' + (i === 0 ? ' today' : '') + '">' +
        '<div class="m-wd-head">' +
          '<span class="m-wd-date">' + (i === 0 ? '今天' : weekdayName(k)) +
            '<small>' + fmtDate(k) + '</small></span>' +
          '<span class="m-wd-sum">' + right + '</span>' +
          '<button class="pd-add" data-act="m-add-open" data-v="' + esc(k) + '" title="给这天加一项">＋</button>' +
        '</div>' +
        (info.tasks.length
          ? '<div class="m-wd-list">' + taskListHtml(state, info.tasks, k, k === tk) + '</div>'
          : '') +
        (draft && draft.mode === 'add' && draft.date === k ? '<div class="m-wd-list">' + addFormHtml(state, k) + '</div>' : '') +
      '</div>';
      d = E.addDays(d, 1);
    }
    return '<div class="m-week">' + out + '</div>';
  }

  function dayDetailHtml(state, key, tk) {
    var info = dayInfo(state, key);
    var tasks = info.tasks;
    var done = tasks.filter(function (t) { return t.status === 'done'; }).length;
    var head = '<div class="pd-head">' +
      '<div class="pd-date">' + (key === tk ? '今天' : weekdayName(key)) +
        '<small>' + fmtDate(key) + '</small></div>' +
      '<div class="pd-right">' +
        '<span class="pd-total">' + (tasks.length ? done + '/' + tasks.length + ' 项' : '空') + '</span>' +
        '<button class="pd-add" data-act="m-add-open" data-v="' + esc(key) + '" title="给这天加一项">＋</button>' +
      '</div>' +
    '</div>';

    var list = taskListHtml(state, tasks, key, key === tk,
      '<div class="tiny muted" style="padding:8px 0">这天还没有安排</div>');

    var formHtml = addFormHtml(state, key);
    return '<div class="m-day">' + head +
      '<div class="m-day-list">' + list + '</div>' + formHtml + '</div>';
  }

  YT.manual = {
    /* 数据 */
    isOn: isOn,
    settings: settings,
    setAdvanced: setAdvanced,
    normalize: normalize,
    ensureDay: ensureDay,
    ordered: ordered,
    find: find,
    add: add,
    remove: remove,
    toggleDone: toggleDone,
    toggleSub: toggleSub,
    move: move,
    duplicate: duplicate,
    moveToDay: moveToDay,
    setSubtask: setSubtask,
    seriesIdOf: seriesIdOf,
    seriesMembers: seriesMembers,
    futureMembers: futureMembers,
    seriesLabel: seriesLabel,
    seriesFutureCount: seriesFutureCount,
    dropSeriesFuture: dropSeriesFuture,
    workText: workText,
    subjectName: subjectName,
    subjectLabel: subjectLabel,
    tags: tags,
    addTag: addTag,
    renameTag: renameTag,
    deleteTag: deleteTag,
    tagUsage: tagUsage,
    subtaskStat: subtaskStat,
    dailyTarget: dailyTarget,
    hasContent: hasContent,
    keepAsChecklist: keepAsChecklist,
    clearAll: clearAll,
    /* 表单 */
    openAdd: openAdd,
    openEdit: openEdit,
    closeAdd: closeAdd,
    currentDraft: currentDraft,
    setDraft: setDraft,
    setDraftScope: setDraftScope,
    setTitle: setTitle,
    setSub: setSub,
    addSub: addSub,
    delSub: delSub,
    startNewTag: startNewTag,
    cancelNewTag: cancelNewTag,
    setNewTag: setNewTag,
    commitNewTag: commitNewTag,
    setMinutes: setMinutes,
    commitAdd: commitAdd,
    commitEdit: commitEdit,
    /* 菜单 */
    openMenu: openMenu,
    currentMenu: currentMenu,
    closeMenu: closeMenu,
    menuHtml: menuHtml,
    openMovePanel: openMovePanel,
    currentMove: currentMove,
    moveHtml: moveHtml,
    /* 批量排 */
    openBatch: openBatch,
    currentBatch: currentBatch,
    closeBatch: closeBatch,
    setBatchField: setBatchField,
    toggleBatchDay: toggleBatchDay,
    batchHtml: batchHtml,
    applyBatchNow: applyBatchNow,
    batchDays: batchDays,
    /* 视图 */
    cardHtml: cardHtml,
    addFormHtml: addFormHtml,
    editFormHtml: editFormHtml,
    todayHtml: todayHtml,
    planHtml: planHtml,
    dayDetailHtml: dayDetailHtml,
    monthKey: monthKey,
    shiftMonth: shiftMonth,
  };
})(window.YT);
