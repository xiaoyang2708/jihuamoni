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
  check('回顾清单里每个模块只出现一次',
    Object.keys(arch.review.reduce((m, r) => (m[r.moduleId] = (m[r.moduleId] || 0) + 1, m), {}))
      .every(k => arch.review.filter(r => r.moduleId === k).length === 1), '');
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

/* ======================= 7. 休息日不算断更 ======================= */
console.log('\n【7】休息日不该算进"断了几天"');
{
  /* 只在周末休息的人：周五学完，周一回来——中间只有周末，等于没断 */
  const p2 = Object.assign({}, profile, { restDays: [0, 6] });
  const s = { profile: p2, roadmap: null, days: {}, scores: [] };
  s.roadmap = E.buildRoadmap(p2, '2026-09-04');
  E.ensureAhead(s, '2026-09-04', 30);
  s.days['2026-09-04'].tasks.forEach(t => { t.status = 'done'; });

  const info = E.restartInfo(s, '2026-09-07');   // 周一
  check('日历上隔了 3 天', info.gap === 3, info.gap);
  check('但一个学习日都没漏', info.missed === 0, info.missed);
  check('不触发断更', info.active === false, JSON.stringify(info));

  /* 反过来：只有周日休息的人，周一到周三都没学，就该算断更 */
  const p3 = Object.assign({}, profile, { restDays: [0] });
  const s3 = { profile: p3, roadmap: null, days: {}, scores: [] };
  s3.roadmap = E.buildRoadmap(p3, '2026-09-04');
  E.ensureAhead(s3, '2026-09-04', 30);
  s3.days['2026-09-04'].tasks.forEach(t => { t.status = 'done'; });
  const info3 = E.restartInfo(s3, '2026-09-09');   // 下周三
  check('该算断更的时候要算', info3.active === true, JSON.stringify(info3));
  check('漏掉的学习日 = 3', info3.missed === 3, info3.missed);
  console.log('     ' + info3.lastKey + ' → ' + '2026-09-09' +
              '：日历 ' + info3.gap + ' 天，学习日 ' + info3.missed + ' 天，系数 ' + info3.factor);
}

/* ======================= 8. 复习清单要给全 ======================= */
console.log('\n【8】复习清单：该给的都要给出来（界面超过 5 条才折叠）');
{
  const s = { profile, roadmap: null, days: {}, scores: [] };
  s.roadmap = E.buildRoadmap(profile, '2026-09-01');
  const mk = (id, i, minutes) => {
    const m = YT.MODULE_BY_ID[id];
    return {
      id: 't' + i, moduleId: id, moduleName: m.name, kind: 'practice',
      title: m.short + ' · 刷题', detail: '', amounts: 1, amount: (m.setSize || 20),
      amountText: (m.setSize || 20) + ' 题', minutes: minutes, status: 'done', actualMinutes: null,
    };
  };
  /* 六个模块：两周前练过一次，之后再没碰 */
  const old = { date: '2026-09-01', isRest: false, stage: 'base', tasks: [], mood: null };
  ['zlfx', 'pdlj', 'pdtx', 'pddl', 'zzll', 'cs'].forEach((id, i) => old.tasks.push(mk(id, i, 50)));
  s.days['2026-09-01'] = old;
  /* 言语昨天刚练，但正确率离目标差得远 */
  s.days['2026-09-13'] = { date: '2026-09-13', isRest: false, stage: 'base',
    tasks: [mk('yy', 90, 54)], mood: null };
  s.scores = [{ date: '2026-09-13', source: '模考', rates: { yy: 0.45 } }];

  const arch = A.build(s, '2026-09-14');
  const ids = arch.review.map(r => r.moduleId);
  check('太久没练的六个模块都列出来了', ['zlfx', 'pdlj', 'pdtx', 'pddl', 'zzll', 'cs'].every(x => ids.indexOf(x) >= 0), ids.join(','));
  check('正确率差的单独出一条「补短板」', arch.review.some(r => r.moduleId === 'yy' && r.title.indexOf('补短板') >= 0),
    JSON.stringify(arch.review.filter(r => r.moduleId === 'yy')));
  check('一共 7 条（会被界面折起来 2 条）', arch.review.length === 7, arch.review.length);
  check('没有重复模块', new Set(ids).size === ids.length, ids.join(','));
  check('正确率信息带在里面', (arch.review.find(r => r.moduleId === 'yy') || {}).detail.indexOf('45%') >= 0,
    JSON.stringify(arch.review.find(r => r.moduleId === 'yy')));
  console.log('     清单 ' + arch.review.length + ' 条：');
  arch.review.forEach(r => console.log('       · ' + r.title + '　' + r.detail));
}

/* ======================= 9. 换考试：封存 + 进度带过去 ======================= */
console.log('\n【9】换一场考试：上一轮封存，课不用重听');
{
  const s = makeState();
  studyDays(s, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  const sum = A.roundSummary(s.days, s.profile);
  check('算得出这轮学了几天', sum.studiedDays === 4, sum.studiedDays);
  check('算得出累计题量', sum.questions > 0, sum.questions);
  check('算得出课程进度', Object.keys(sum.course).some(k => sum.course[k] > 0),
    JSON.stringify(sum.course));

  /* 开启新一轮：日历清空，进度带过去 */
  const before = Object.assign({}, s.profile, { inheritedProgress: sum.course });
  const s2 = { profile: before, roadmap: null, days: {}, scores: [] };
  const prog2 = E.courseProgress(s2);
  check('新课的进度接着上一轮', prog2.zlfx === sum.course.zlfx, prog2.zlfx + ' vs ' + sum.course.zlfx);
  check('换轮后不会从第 1 节重排',
    E.currentCourseModule(before, prog2).id !== 'zlfx' || sum.course.zlfx < E.targetUnits(YT.MODULE_BY_ID.zlfx, before),
    E.currentCourseModule(before, prog2).id);

  /* 新一轮排出来的课，是接着上一轮往下听的 */
  s2.roadmap = E.buildRoadmap(before, '2026-09-10');
  E.ensureAhead(s2, '2026-09-10', 10);
  const firstCourse = Object.keys(s2.days).sort()
    .map(k => (s2.days[k].tasks || []).find(t => t.kind === 'course' && t.moduleId === 'zlfx'))
    .find(Boolean);
  console.log('     新一轮第一节资料课：' + (firstCourse ? firstCourse.detail : '（没有了）'));
  check('不会又让人从第 1 节听起',
    !firstCourse || firstCourse.detail.indexOf('第 1 节') < 0,
    firstCourse && firstCourse.detail);
}

console.log('\n' + (fail ? '有 ' + fail + ' 条没过 ❌' : '全部通过 ✅'));
process.exit(fail ? 1 : 0);
