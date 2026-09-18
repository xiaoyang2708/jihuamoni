/* 在命令行里跑一遍计划引擎，不打开界面就能看到排出来的任务。
 * 用法： node tools/simulate.js [还有几个月考试]
 * 例：   node tools/simulate.js 1.2   —— 模拟一个只剩 5 周、会走完冲刺期的备考
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* 浏览器里 window 就是全局对象，这里把 sandbox 自己当作 window，
 * 这样 config.js 里 `window.YT = ...` 之后，裸写的 YT 才解析得到。 */
const sandbox = { console, Date, Math, JSON, isFinite };
sandbox.window = sandbox;
vm.createContext(sandbox);

['js/config.js', 'js/engine.js', 'js/stats.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});

const YT = sandbox.window.YT;
const E = YT.engine;

/* ---- 造一个用户 ---- */
const monthsAhead = process.argv[2] ? Number(process.argv[2]) : 4;
const today = new Date();
const exam = new Date(today.getFullYear(), today.getMonth(), today.getDate());
exam.setDate(exam.getDate() + Math.round(monthsAhead * 30));

const profile = {
  examDate: E.toKey(exam),
  base: 'zero',
  weekdayMinutes: 120,
  weekendMinutes: 360,
  restDays: [0],
  lessonMinutes: 150,
  speed: 1.5,
  courseUnits: {},
  benchmarks: {},
  strength: {},
};
YT.MODULES.forEach(m => {
  profile.courseUnits[m.id] = m.courseUnits;
  profile.strength[m.id] = 'normal';
});

const state = {
  profile,
  roadmap: null,
  days: {},
};

const todayKey = E.toKey(today);
state.roadmap = E.buildRoadmap(profile, todayKey);

console.log('='.repeat(64));
console.log('考试日期：' + profile.examDate + '　工作日 ' + profile.weekdayMinutes +
            ' 分钟　周末 ' + profile.weekendMinutes + ' 分钟　休息日：周' +
            profile.restDays.map(d => YT.WEEKDAY_NAMES[d]).join('、'));
console.log('可用学习日合计：' + state.roadmap.totalStudyDays + ' 天');
console.log('');

state.roadmap.stages.forEach(st => {
  console.log('  【' + st.name + '】' + (st.startKey || '—') + ' → ' + (st.endKey || '—') +
              '　' + st.studyDays + ' 个学习日');
  console.log('      ' + st.goal);
});
console.log('');

const lc = state.roadmap.lessonCheck;
console.log('听课体检：共需 ' + lc.totalMinutes + ' 分钟（' + (lc.totalMinutes / 60).toFixed(1) +
            ' 小时），按当前节奏需要 ' + lc.needDays + ' 个学习日，基础期有 ' + lc.baseDays + ' 天 → ' +
            (lc.fit ? '排得下' : '排不下，会挤压后面的阶段'));
console.log('');

E.ensureAhead(state, todayKey, Math.min(state.roadmap.totalStudyDays, 60));

/* 阶段是"学完了没有"算出来的，不是按日期切的——单独看一眼实际形状 */
const fc = E.forecast(state, todayKey);
if (fc) {
  console.log('按进度推进算出来（不是按日期切）：');
  fc.stages.forEach(st => {
    console.log('  【' + st.name + '】' + (st.startKey || '—') + ' → ' + (st.endKey || '—') +
                '　' + st.studyDays + ' 个学习日');
  });
  console.log('  课听完：' + (fc.courseDoneKey || '—') +
              '　进冲刺：' + (fc.sprintKey || '—') +
              '　离考试还有 ' + fc.studyDaysToExam + ' 个学习日');
  console.log('');
}

console.log('='.repeat(64));
console.log('接下来 14 个学习日的安排');
console.log('='.repeat(64));

const allDays = Object.keys(state.days).sort().filter(k => !state.days[k].isRest);

allDays.slice(0, 14).forEach(k => {
  const day = state.days[k];
  const total = day.tasks.reduce((s, t) => s + t.minutes, 0);
  console.log('');
  console.log(k + '　周' + YT.WEEKDAY_NAMES[E.parseKey(k).getDay()] +
              '　' + day.stage + '　合计 ' + total + ' 分钟');
  day.tasks.forEach(t => {
    console.log('   · ' + pad(t.title, 16) + pad(t.detail || '', 22) +
                pad(t.amountText || '', 12) + t.minutes + ' 分钟');
  });
});

/* 冲刺期抽样，看看后半段排成什么样 */
const sprintDays = allDays.filter(k => state.days[k].stage === 'sprint');
if (sprintDays.length) {
  console.log('');
  console.log('='.repeat(64));
  console.log('冲刺期抽样');
  console.log('='.repeat(64));
  sprintDays.slice(0, 5).forEach(k => {
    const day = state.days[k];
    const total = day.tasks.reduce((s, t) => s + t.minutes, 0);
    console.log('');
    console.log(k + '　周' + YT.WEEKDAY_NAMES[E.parseKey(k).getDay()] +
                '　冲刺期　合计 ' + total + ' 分钟');
    day.tasks.forEach(t => {
      console.log('   · ' + pad(t.title, 16) + pad(t.detail || '', 22) +
                  pad(t.amountText || '', 12) + t.minutes + ' 分钟');
    });
  });
}

/* ---- 模拟随机打卡后统计 ---- */
console.log('');
console.log('='.repeat(64));
console.log('模拟打卡：随机完成 60% 的任务，其中一半填了实际用时');
console.log('='.repeat(64));

const keys = Object.keys(state.days).sort();
keys.forEach((k, di) => {
  const day = state.days[k];
  if (day.isRest) return;
  day.tasks.forEach(t => {
    const r = (di * 37 + t.minutes * 7) % 100;
    if (r < 45) {
      t.status = 'done';
      if (r % 2 === 0) t.actualMinutes = Math.round(t.minutes * (0.8 + (r % 40) / 100));
    } else if (r < 60) {
      t.status = 'half';
    }
  });
});

const timing = sandbox.window.YT.stats.moduleTiming(state);
console.log('');
console.log(pad('模块', 16) + pad('记录', 8) + pad('每题中位', 12) + pad('当前基准', 12) + '建议');
timing.forEach(r => {
  console.log(
    pad(r.name, 16) +
    pad(r.samples, 8) +
    pad(r.medianPerQuestion === null ? '—' : (Math.round(r.medianPerQuestion * 10) / 10) + ' 分', 12) +
    pad(r.current + ' 分', 12) +
    (r.suggestion === null ? '数据不足' : r.suggestion + ' 分')
  );
});

const o = sandbox.window.YT.stats.overall(state);
console.log('');
console.log('累计：计划 ' + o.planned + ' 分钟，完成 ' + o.done + ' 分钟，完成率 ' +
            Math.round(o.rate * 100) + '%，学习 ' + o.daysStudied + ' 天');

/* ---- 场景：上一周大面积没做完，下一周会不会自动减量 ---- */
console.log('');
console.log('='.repeat(64));
console.log('自动降档验证');
console.log('='.repeat(64));

const st2 = { profile: JSON.parse(JSON.stringify(profile)), roadmap: null, days: {}, weeklyLog: [] };
const pastStart = E.toKey(E.addDays(today, -14));
st2.roadmap = E.buildRoadmap(st2.profile, pastStart);
E.ensureAhead(st2, pastStart, 40);

const wk1 = E.weekKeyOf(pastStart);
const wk2 = E.toKey(E.addDays(E.parseKey(wk1), 7));

const dayTotals = (st, weekKey) => Object.keys(st.days)
  .filter(k => E.weekKeyOf(k) === weekKey && !st.days[k].isRest)
  .map(k => st.days[k].tasks.reduce((s, t) => s + t.minutes, 0))
  .filter(n => n > 0);

const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

const baseline = avg(dayTotals(st2, wk2));
console.log('调整前，第二周平均每天：' + baseline + ' 分钟');

/* 把第一周做成"只完成了四分之一" */
Object.keys(st2.days).filter(k => E.weekKeyOf(k) === wk1).forEach(k => {
  st2.days[k].tasks.forEach((t, i) => { t.status = i % 4 === 0 ? 'done' : 'todo'; });
  st2.days[k].rolled = true;
});

const ws1 = E.weekStats(st2, wk1);
console.log('第一周实际完成率：' + Math.round(ws1.rate * 100) + '%');

/* 删掉第二周，按新的完成情况重排 */
Object.keys(st2.days).forEach(k => {
  if (E.weekKeyOf(k) === wk2) delete st2.days[k];
});
E.ensureAhead(st2, wk2, 6);

const after = avg(dayTotals(st2, wk2));
const rf = E.reflowForDate(st2, wk2);
console.log('触发的规则：' + (rf.rule ? rf.rule.label : '无（前一周没有数据）'));
console.log('调整后，第二周平均每天：' + after + ' 分钟  （降幅 ' +
            (baseline ? Math.round((1 - after / baseline) * 100) : 0) + '%）');

/* ---- 场景：今天选"太难了"，接下来的计划会不会真的变 ---- */
console.log('');
console.log('='.repeat(64));
console.log('感受微调验证');
console.log('='.repeat(64));

const st3 = { profile: JSON.parse(JSON.stringify(profile)), roadmap: null, days: {}, weeklyLog: [], weekMark: {} };
const start3 = E.toKey(new Date());
st3.roadmap = E.buildRoadmap(st3.profile, start3);
E.ensureAhead(st3, start3, 8);

const tomorrow = Object.keys(st3.days).sort()
  .filter(k => !st3.days[k].isRest && k > start3)[0];

const snapshot = k => st3.days[k].tasks.map(t =>
  t.title + ' ' + (t.amount ? t.amount + ' 题' : '') + ' ' + t.minutes + ' 分').join('\n     ');

console.log('明天（' + tomorrow + '）原本是：');
console.log('     ' + snapshot(tomorrow));

YT.MOOD_LABEL_KEYS = ['easy', 'ok', 'tired', 'hard'];
['easy', 'tired', 'hard'].forEach(mood => {
  st3.days[start3].mood = mood;
  Object.keys(st3.days).forEach(k => {
    if (k <= start3) return;
    const d = st3.days[k];
    const touched = d.mood || d.tasks.some(t => t.status !== 'todo');
    if (!touched) delete st3.days[k];
  });
  E.ensureAhead(st3, start3, 8);

  const mf = E.moodFactor(st3, start3);
  console.log('');
  console.log('今天选「' + YT.MOOD_LABEL[mood] + '」→ 系数 ×' + mf.factor +
              '（' + (mf.factor > 1 ? '+' : '') + Math.round((mf.factor - 1) * 100) + '%）');
  console.log('     ' + snapshot(tomorrow));
});

/* ---- 模拟完成率很低时的重排 ---- */
console.log('');
console.log('='.repeat(64));
console.log('重排规则检查');
console.log('='.repeat(64));
[0.95, 0.7, 0.5, 0.2].forEach(r => {
  const rule = E.reflowRule(r);
  console.log('  完成率 ' + Math.round(r * 100) + '% → ' + rule.label + '（系数 ' + rule.factor + '）');
});

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}
