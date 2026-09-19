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
