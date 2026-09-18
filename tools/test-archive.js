/* 验证"学习档案 + 断更重启"的纯逻辑。
 * 用法：node tools/test-archive.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const sandbox = { console, Date, Math, JSON, isFinite };
sandbox.window = sandbox;
vm.createContext(sandbox);

['js/config.js', 'js/engine.js', 'js/stats.js', 'js/archive.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});

const YT = sandbox.window.YT;
const E = YT.engine;
const A = YT.archive;

let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond ? '' : '   ← ' + extra));
  if (!cond) fail++;
}

/* ---- 造一个用户：今天开始备考，12 天后考试那会儿再看 ---- */
const start = new Date(2026, 8, 1);
const startKey = E.toKey(start);
const exam = new Date(2026, 11, 20);

const profile = {
  examDate: E.toKey(exam),
  base: 'zero',
  weekdayMinutes: 180,
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

function makeState() {
  const s = { profile, roadmap: null, days: {}, scores: [] };
  s.roadmap = E.buildRoadmap(profile, startKey);
  E.ensureAhead(s, startKey, 30);
  return s;
}

/* 学 5 天，每天完成 80% 的任务，其中资料分析都完成 */
function studyDays(s, keys) {
  keys.forEach((k, i) => {
    const day = s.days[k];
    if (!day) return;
    day.tasks.forEach((t, ti) => {
      if (ti % 5 === 0 && i < keys.length - 1) return;      // 留几个没完成的
      t.status = 'done';
      t.log = [{ at: k + 'T20:00:00.000Z', status: 'done' }];
    });
  });
}

/* ======================= 1. 没断更 ======================= */
console.log('\n【1】每天都有学：不该触发重启');
{
  const s = makeState();
  const k1 = E.toKey(new Date(2026, 8, 1));
  const k5 = E.toKey(new Date(2026, 8, 5));
  studyDays(s, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
  const info = E.restartInfo(s, '2026-09-06');
  check('停 1 天不算断更', info.active === false && info.gap === 1, JSON.stringify(info));
  check('系数是 1', info.factor === 1, info.factor);
}

/* ======================= 2. 停 5 天 ======================= */
console.log('\n【2】停了 5 天：回来第一天 80%');
{
  const s = makeState();
  studyDays(s, ['2026-09-01', '2026-09-02', '2026-09-03']);
  const info = E.applyRestart(s, '2026-09-08');
  check('识别为短断更', info && info.level === 'short', JSON.stringify(info));
  check('间隔 5 天', info.gap === 5, info.gap);
  check('系数 0.8', info.factor === 0.8, info.factor);
  /* 9/4、9/5、9/7 是学习日，9/6 是周日（休息日，不用清） */
  check('清掉了中间没碰过的日子', info.clearedDays === 3, '清掉 ' + info.clearedDays + ' 天');
  check('被清的日子不再计入计划量',
    E.dayStats(s.days['2026-09-04']).planned === 0,
    E.dayStats(s.days['2026-09-04']).planned);
  check('学过的日子没被动', (s.days['2026-09-03'].tasks || []).some(t => t.status === 'done'), '');

  E.ensureAhead(s, '2026-09-08', 5);
  const today = s.days['2026-09-08'];
  check('今天重排了', !!today, '');
  const total = today.tasks.reduce((a, t) => a + t.minutes, 0);
  check('今天的量比正常少（≈80%）', total > 0 && total <= profile.weekdayMinutes * 0.85,
    total + ' 分钟 / 正常 ' + profile.weekdayMinutes);
  console.log('     今天排了：' + total + ' 分钟（正常 ' + profile.weekdayMinutes + '）');
}

/* ======================= 3. 停 12 天 ======================= */
console.log('\n【3】停了 12 天：60%，而且不补落下的');
{
  const s = makeState();
  studyDays(s, ['2026-09-01', '2026-09-02', '2026-09-03']);
  const info = E.applyRestart(s, '2026-09-15');
  check('识别为长断更', info && info.level === 'long', JSON.stringify(info));
  check('系数 0.6', info.factor === 0.6, info.factor);

  const carried = Object.keys(s.days).filter(k => k > '2026-09-03' && k < '2026-09-15')
    .filter(k => (s.days[k].tasks || []).length > 0);
  check('断更期间一条待办都没留', carried.length === 0, carried.join(','));

  E.ensureAhead(s, '2026-09-15', 3);
  const total = s.days['2026-09-15'].tasks.reduce((a, t) => a + t.minutes, 0);
  check('回来第一天按 60% 排', total > 0 && total <= profile.weekdayMinutes * 0.65,
    total + ' 分钟');
  console.log('     今天排了：' + total + ' 分钟（正常 ' + profile.weekdayMinutes + '）');

  /* 第二天要恢复正常，不能一直打折 */
  const k2 = E.toKey(E.addDays(E.parseKey('2026-09-15'), 1));
  const next = s.days[k2];
  if (next) {
    const t2 = next.tasks.reduce((a, t) => a + t.minutes, 0);
    check('第二天不再打折', t2 > profile.weekdayMinutes * 0.7, t2 + ' 分钟');
  }
}

/* ======================= 4. 学习档案 ======================= */
console.log('\n【4】学习档案的内容');
{
  const s = makeState();
  studyDays(s, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  const arch = A.build(s, '2026-09-14');
  check('算得出上次学习是哪天', arch.lastKey === '2026-09-04', arch.lastKey);
  check('算得出隔了几天', arch.gap === 10, arch.gap);
  check('有听课进度', arch.courses.length > 0, '');
  check('听课进度带"学到哪了"这句话',
    arch.courses.every(c => typeof c.lessonText === 'string' && c.lessonText.length > 0), '');
  check('刷题累计大于 0', arch.questionTotal > 0, arch.questionTotal);
  check('有回顾建议', arch.review.length > 0, '');
  check('回顾建议最多 3 条', arch.review.length <= 3, arch.review.length);
  console.log('     累计做了 ' + arch.questionTotal + ' 题；建议：');
  arch.review.forEach(r => console.log('       · ' + r.title + '　' + r.detail + '　' + r.minutes + ' 分钟'));
  console.log('     听课进度：' + arch.courses.slice(0, 4).map(c =>
    c.short + ' ' + c.done + '/' + c.need + '（' + c.lessonText + '）').join('　'));
}

/* ======================= 5. 从没学过 ======================= */
console.log('\n【5】一天都没打过卡：不硬说"你断了 20 天"');
{
  const s = makeState();
  const arch = A.build(s, '2026-09-20');
  check('没有学习记录', arch.everStudied === false, '');
  check('不会算出间隔', arch.gap === null, arch.gap);
  check('回顾建议不硬凑', arch.review.length === 0, JSON.stringify(arch.review));
  const info = E.restartInfo(s, '2026-09-20');
  check('不触发断更重启（没有可对比的上一段）', info.active === false, JSON.stringify(info));
}

/* ======================= 6. 自己加的任务要保住 ======================= */
console.log('\n【6】断更期间自己加过任务的那天，不能被清掉');
{
  const s = makeState();
  studyDays(s, ['2026-09-01']);
  s.days['2026-09-05'].tasks.push({
    id: 'u1', moduleId: 'zlfx', moduleName: '资料分析', kind: 'practice',
    title: '资料 · 刷题', detail: '', amounts: 1, amountText: '20 题',
    minutes: 50, status: 'todo', actualMinutes: null, userAdded: true,
  });
  E.applyRestart(s, '2026-09-10');
  const left = s.days['2026-09-05'].tasks || [];
  check('自己加的任务还在', left.filter(t => t.userAdded).length === 1, JSON.stringify(left));
  check('系统排的那几条被清掉了', left.filter(t => !t.userAdded).length === 0, JSON.stringify(left));
}

console.log('\n' + (fail ? '有 ' + fail + ' 条没过 ❌' : '全部通过 ✅'));
process.exit(fail ? 1 : 0);
