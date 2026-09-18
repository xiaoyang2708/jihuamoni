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

/* ======================= 10. 偏好层：老自己加同一科 ======================= */
console.log('\n【10】连续几天自己加同一科，系统该开口问一句');
{
  const s = { profile, roadmap: null, days: {}, scores: [] };
  s.roadmap = E.buildRoadmap(profile, '2026-09-01');
  const selfMade = (id, i) => {
    const m = YT.MODULE_BY_ID[id];
    return {
      id: 'u' + i, moduleId: id, moduleName: m.name, kind: 'practice',
      title: m.short + ' · 加练', detail: '', amount: 20, amounts: 1,
      amountText: '20 题', minutes: 50, status: 'todo', actualMinutes: null, userAdded: true,
    };
  };
  ['2026-09-07', '2026-09-08', '2026-09-09'].forEach((k, i) => {
    s.days[k] = { date: k, isRest: false, stage: 'base',
      tasks: [mkTask('zlfx', i), selfMade('pdlj', i)].filter(Boolean), mood: null };
  });
  function mkTask(id, i) {
    const m = YT.MODULE_BY_ID[id];
    return { id: 's' + i, moduleId: id, moduleName: m.name, kind: 'practice',
      title: m.short + ' · 刷题', detail: '', amount: 20, amounts: 1,
      amountText: '20 题', minutes: 50, status: 'todo', actualMinutes: null };
  }

  const hits = A.selfAddedByModule(s, '2026-09-10', 5);
  const pdlj = hits.find(h => h.moduleId === 'pdlj');
  check('数得出自己加了几天', pdlj && pdlj.days === 3, JSON.stringify(hits));
  check('系统排的不算进去', !hits.some(h => h.moduleId === 'zlfx'), JSON.stringify(hits));
  check('只出现一次（按模块聚合）', hits.filter(h => h.moduleId === 'pdlj').length === 1, hits.length);

  /* 主动"换成"这一科，也该算成"我想多练它" */
  s.swapLog = [{ date: '2026-09-07', from: 'yy', to: 'zzll' }];
  const hits2 = A.selfAddedByModule(s, '2026-09-10', 5);
  check('换成这一科也算数',
    (hits2.find(h => h.moduleId === 'zzll') || {}).days === 1,
    JSON.stringify(hits2));

  /* 权重加成：只影响刷题分配，不动听课节数 */
  const before = profile.examDate;
  check('加成不影响听课节数',
    E.targetUnits(YT.MODULE_BY_ID.pdlj, profile) ===
    E.targetUnits(YT.MODULE_BY_ID.pdlj, Object.assign({}, profile, { practiceBoost: { pdlj: 1.4 } })),
    '听课节数被改动了');
}

/* ======================= 11. 行测学习顺序 ======================= */
console.log('\n【11】用户能自己定行测的学习顺序');
{
  const p1 = Object.assign({}, profile);
  check('没设过顺序时按默认：资料第一个',
    E.moduleOrder(p1)[0] === 'zlfx', E.moduleOrder(p1).join(','));
  check('申论在队尾（它走自己那条线）',
    E.moduleOrder(p1)[E.moduleOrder(p1).length - 1] === 'slw', E.moduleOrder(p1).join(','));

  /* 用户把言语拉到最前面 */
  const ids = E.moduleOrder(p1);
  const moved = ['yy'].concat(ids.filter(x => x !== 'yy'));
  const p2 = Object.assign({}, p1, { moduleOrder: moved });
  check('顺序按用户设的走', E.moduleOrder(p2)[0] === 'yy', E.moduleOrder(p2).join(','));

  const s = { profile: p2, roadmap: null, days: {}, scores: [] };
  const tk = E.toKey(new Date(2026, 8, 18));
  s.roadmap = E.buildRoadmap(p2, tk);
  E.ensureAhead(s, tk, 6);
  const firstCourses = [];
  Object.keys(s.days).sort().forEach(k => {
    (s.days[k].tasks || []).forEach(t => {
      if (t.kind !== 'course') return;
      if (t.moduleId === 'slw') return;   // 申论走自己那条线，不算在行测顺序里
      if (firstCourses.indexOf(t.moduleId) === -1) firstCourses.push(t.moduleId);
    });
  });
  check('实际排出来的课也从言语开始', firstCourses[0] === 'yy', firstCourses.join(','));

  /* 老档案里少一个模块、多一个不认识的 id，也不能崩 */
  const p3 = Object.assign({}, p1, { moduleOrder: ['nope', 'sl'] });
  const o3 = E.moduleOrder(p3);
  check('顺序表缺模块会补齐、多余的丢掉',
    o3.length === ids.length && o3.indexOf('nope') === -1 && o3[0] === 'sl', o3.join(','));
}

/* ======================= 12. 各种任务字段要对得上 ======================= */
console.log('\n【12】任务字段契约：排出来的任务，统计读得到');
{
  const s = { profile, roadmap: null, days: {}, scores: [] };
  const tk = E.toKey(new Date(2026, 8, 18));
  s.roadmap = E.buildRoadmap(profile, tk);
  E.ensureAhead(s, tk, 30);
  const all = [];
  Object.keys(s.days).forEach(k => (s.days[k].tasks || []).forEach(t => all.push(t)));

  const practice = all.filter(t => t.kind === 'practice');
  const course = all.filter(t => t.kind === 'course');
  const essay = all.filter(t => t.kind === 'essay');
  check('每个刷题任务都有题量 amount', practice.every(t => t.amount > 0), practice.length);
  check('每个刷题任务都有组数 sets（专项达标要数它）', practice.every(t => t.sets > 0), practice.length);
  check('每个听课任务都有节数 units', course.every(t => t.units > 0), course.length);
  check('每个申论任务都有道数 amounts', essay.every(t => t.amounts > 0), essay.length);

  /* 拿真实数据跑一遍消费者，看有没有读到 undefined。
   * 统计只认打过卡的，所以先把它们标成完成。 */
  all.forEach(t => { t.status = 'done'; });
  const sets = E.moduleSets(s);
  const counted = Object.keys(sets).filter(k => sets[k] > 0);
  check('专项组数算得出来（不是一堆 0）', counted.length >= 3, JSON.stringify(sets));
  const arch = A.build(s, E.toKey(new Date(2026, 10, 1)), 'base');
  check('学习档案的累计题量算得出来', arch.questionTotal > 0, arch.questionTotal);
}

/* ======================= 13. 正确率驱动的建议 ======================= */
console.log('\n【13】有了成绩之后，建议要有依据、要能点');
{
  const base = () => ({ profile: Object.assign({}, profile), days: {}, scores: [] });

  check('没录过成绩就不瞎说', A.advice(base(), '2026-10-01').length === 0, '');

  const s1 = base();
  s1.scores = [{ date: '2026-09-20', source: '模考', rates: { zlfx: 0.60 } }];
  const a1 = A.advice(s1, '2026-10-01');
  check('低于目标会建议加强',
    a1.some(x => x.moduleId === 'zlfx' && x.action === 'set-strong'), JSON.stringify(a1));
  check('建议里带上具体数字',
    a1.length && a1[0].text.indexOf('60%') >= 0 && a1[0].text.indexOf('85%') >= 0, a1.length ? a1[0].text : '');

  const s2 = base();
  s2.profile.strength = { zlfx: 'strong' };
  s2.scores = [{ date: '2026-09-20', source: '模考', rates: { zlfx: 0.92 } }];
  const a2 = A.advice(s2, '2026-10-01');
  check('超过目标又挂着加强 → 建议让出时间',
    a2.some(x => x.moduleId === 'zlfx' && x.action === 'set-normal'), JSON.stringify(a2));

  const s3 = base();
  s3.scores = [
    { date: '2026-09-01', source: '模考', rates: { yy: 0.66 } },
    { date: '2026-09-10', source: '模考', rates: { yy: 0.67 } },
    { date: '2026-09-20', source: '模考', rates: { yy: 0.66 } },
  ];
  const a3 = A.advice(s3, '2026-10-01');
  const rel = a3.find(x => x.kind === 'relisten');
  check('连续三次不动 → 提示回去重听课', !!rel, JSON.stringify(a3));
  check('这种提示不给动作（不该一键改计划）', rel && rel.action === null, JSON.stringify(rel));

  const s4 = base();
  s4.scores = [
    { date: '2026-09-05', source: '模块刷题', rates: { zlfx: 0.88 } },
    { date: '2026-09-12', source: '模块刷题', rates: { zlfx: 0.90 } },
    { date: '2026-09-20', source: '真题套卷', rates: { zlfx: 0.45 } },
  ];
  const a4 = A.advice(s4, '2026-10-01');
  check('套卷比平时低一大截 → 提议练专项',
    a4.some(x => x.kind === 'backToSpecial' && x.action === 'boost'), JSON.stringify(a4));

  const s5 = base();
  s5.scores = [{ date: '2026-09-20', source: '模考', rates: { sl: 0.20, cs: 0.30 } }];
  check('没设目标的模块不产生建议', A.advice(s5, '2026-10-01').length === 0,
    JSON.stringify(A.advice(s5, '2026-10-01')));

  const s6 = base();
  s6.scores = [{ date: '2026-09-20', source: '模考',
    rates: { zlfx: 0.30, yy: 0.30, pdlj: 0.30, pdtx: 0.30, pddl: 0.30, zzll: 0.20 } }];
  check('最多三条，不搞批斗会', A.advice(s6, '2026-10-01').length <= 3, A.advice(s6, '2026-10-01').length);
}

/* ======================= 14. 各科档位（只显示，不锁） ======================= */
console.log('\n【14】档位是导航，不是关卡');
{
  const base = () => ({ profile: Object.assign({}, profile), days: {}, scores: [] });

  const l0 = A.moduleLevels(base(), '2026-10-01');
  check('没数据时不会瞎给档位', l0.every(x => x.level === 0), JSON.stringify(l0.map(x => x.level)));

  const s1 = base();
  s1.days['2026-09-01'] = { date: '2026-09-01', isRest: false, stage: 'base', mood: null,
    tasks: [{ id: 'p1', moduleId: 'zlfx', moduleName: '资料分析', kind: 'practice',
      title: '资料 · 刷题', amount: 400, sets: 20, minutes: 500, status: 'done' }] };
  const l1 = A.moduleLevels(s1, '2026-10-01').filter(x => x.moduleId === 'zlfx')[0];
  check('光练不录成绩也能进第二档', l1.level === 2, JSON.stringify(l1));

  const s2 = base();
  s2.scores = [{ date: '2026-09-20', source: '模考', rates: { zlfx: 0.86 } }];
  const l2 = A.moduleLevels(s2, '2026-10-01').filter(x => x.moduleId === 'zlfx')[0];
  check('到目标就进"限时提速"档', l2.level === 3, JSON.stringify(l2));
  check('这一档说人话', l2.note.indexOf('压时间') >= 0, l2.note);

  const s3 = base();
  s3.scores = [
    { date: '2026-09-10', source: '模考', rates: { zlfx: 0.90 } },
    { date: '2026-09-20', source: '模考', rates: { zlfx: 0.92 } },
  ];
  const l3 = A.moduleLevels(s3, '2026-10-01').filter(x => x.moduleId === 'zlfx')[0];
  check('连续两次稳在目标上 → 保持手感', l3.level === 4, JSON.stringify(l3));

  const s4 = base();
  s4.scores = [{ date: '2026-09-20', source: '模考', rates: { zlfx: 0.78 } }];
  const l4 = A.moduleLevels(s4, '2026-10-01').filter(x => x.moduleId === 'zlfx')[0];
  check('差一点 → 第二档', l4.level === 2, JSON.stringify(l4));
  check('把差距说成数字', l4.gap === 7, l4.gap);

  const s5 = base();
  s5.scores = [
    { date: '2026-09-01', source: '模考', rates: { yy: 0.66 } },
    { date: '2026-09-10', source: '模考', rates: { yy: 0.67 } },
    { date: '2026-09-20', source: '模考', rates: { yy: 0.66 } },
  ];
  const l5 = A.moduleLevels(s5, '2026-10-01').filter(x => x.moduleId === 'yy')[0];
  check('平台期不会卡在某一档不动', l5.level >= 2, JSON.stringify(l5));
  check('平台期说的是"该换练法"',
    l5.note.indexOf('换练法') >= 0 && l5.note.indexOf('别再加量') >= 0, l5.note);

  const s6 = base();
  s6.profile.strength = { sl: 'skip' };
  const l6 = A.moduleLevels(s6, '2026-10-01').map(x => x.moduleId);
  check('标记"不学"的科目不出现', l6.indexOf('sl') === -1, l6.join(','));
  check('申论不参与（它不按正确率算）', l6.indexOf('slw') === -1, l6.join(','));
}

console.log('\n' + (fail ? '有 ' + fail + ' 条没过 ❌' : '全部通过 ✅'));
process.exit(fail ? 1 : 0);
