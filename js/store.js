/* =========================================================================
 * store.js —— 数据存取（localStorage）
 * 每条记录都带用户维度，将来上多用户不用推倒重来。
 * ========================================================================= */

window.YT = window.YT || {};

(function (YT) {
  'use strict';

  var KEY = 'yang-toolbox/v1';

  function defaults() {
    return {
      version: 1,
      userId: 'local-user',
      profile: null,
      roadmap: null,
      days: {},
      rounds: [],        // 已经考完并封存的历史轮次
      weeklyLog: [],
      adjustLog: [],     // 计划调整记录：跨周、断更、阶段变化、结构性改动
      /* 番茄钟（工具）+ 清单的轻量设置。挂在 state 上，
       * 跟 profile 分开——这样换考试、换模式都不会把专注记录带走。 */
      focus: {
        settings: { work: 25, short: 5, long: 15, rounds: 4 },
        sessions: [],
      },
      /* 自己排：清单的界面开关（高级项默认全关）。 */
      manual: {
        /* advanced：加任务表单里的可选块（子任务/重复/提醒），默认全关。
         * askActual：完成时是否弹窗问"实际用了多久"，默认开。 */
        settings: { advanced: { subtask: false, repeat: false, remind: false }, askActual: true },
        tags: [],   // 用户自定义的科目标签 [{id,name}]
      },
      /* 反馈事件流。本轮只渲染成文案和数据，将来接轻游戏化直接消费它。 */
      feedback: { events: [] },
      ui: { screen: 'today', onboardStep: 0 },
      createdAt: new Date().toISOString(),
    };
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return defaults();
      var s = JSON.parse(raw);
      var d = defaults();
      Object.keys(d).forEach(function (k) {
        if (s[k] === undefined) s[k] = d[k];
      });
      return s;
    } catch (e) {
      console.warn('读取本地数据失败，已重置', e);
      return defaults();
    }
  }

  function save(state) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('保存失败', e);
      return false;
    }
  }

  function reset() {
    try { window.localStorage.removeItem(KEY); } catch (e) {}
    return defaults();
  }

  function exportJSON(state) {
    return JSON.stringify(state, null, 2);
  }

  function importJSON(text) {
    var s = JSON.parse(text);
    if (!s || typeof s !== 'object' || !s.profile) throw new Error('文件格式不对');
    var d = defaults();
    Object.keys(d).forEach(function (k) {
      if (s[k] === undefined) s[k] = d[k];
    });
    return s;
  }

  YT.store = {
    KEY: KEY,
    defaults: defaults,
    load: load,
    save: save,
    reset: reset,
    exportJSON: exportJSON,
    importJSON: importJSON,
  };
})(window.YT);
