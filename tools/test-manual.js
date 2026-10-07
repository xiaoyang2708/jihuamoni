/* 「自己排」的纯逻辑契约测试：编辑、重复系列、改期、批量排、今日口径。
 * 用法：node tools/test-manual.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const sandbox = { console, Date, Math, JSON, isFinite };
sandbox.window = sandbox;
vm.createContext(sandbox);

['js/config.js', 'js/engine.js', 'js/stats.js', 'js/archive.js', 'js/feedback.js', 'js/manual.js']
  .forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }));

const YT = sandbox.window.YT;
const E = YT.engine;
const M = YT.manual;
const S = YT.stats;

let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond ? '' : '   ← ' + extra));
  if (!cond) fail++;
}

/* ---- 一个自己排的用户 ---- */
const TK = '2026-09-10';           // 周四
const profile = {
  examDate: '2026-12-20', mode: 'manual',
  weekdayMinutes: 180, weekendMinutes: 360, restDays: [0],
  lessonMinutes: 150, speed: 1.5, courseUnits: {}, benchmarks: {}, strength: {},
};
YT.MODULES.forEach(m => {
  profile.courseUnits[m.id] = m.courseUnits;
  profile.strength[m.id] = 'normal';
});

function makeState() {
  return {
    profile: JSON.parse(JSON.stringify(profile)),
    days: {}, scores: [], focus: { sessions: [] },
    manual: { settings: { advanced: { repeat: true }, askActual: true }, tags: [] },
    ui: {},
  };
}

/* ================= 1. 今日专注的口径 ================= */
console.log('\n【1】focusToday 只算当天');
{
  const s = makeState();
  const mk = (key, minutes, completed) => ({
    startedAt: key + 'T09:00:00.000Z', endedAt: key + 'T09:25:00.000Z',
    minutes: minutes, mode: 'pomodoro', completed: !!completed,
  });
  s.focus.sessions = [mk('2026-09-08', 50, true), mk('2026-09-09', 25, true), mk('2026-09-10', 30, true)];
  const today = S.focusToday(s, TK);
  check('今天只算当天那一条', today.minutes === 30 && today.pomodoros === 1, JSON.stringify(today));
  const all = S.focusTotals(s, TK);
  check('累计口径不变（105 分钟 / 3 个番茄）', all.minutes === 105 && all.pomodoros === 3, JSON.stringify(all));
  check('没学过的那天是 0', S.focusToday(s, '2026-09-07').minutes === 0);
}

/* ================= 2. 重复展开挂同一个系列号 ================= */
console.log('\n【2】一次重复展开的就是一个系列');
{
  const s = makeState();
  const res = M.add(s, TK, { title: '民法', moduleId: 'zlfx', minutes: 30, repeat: { freq: 'daily', until: '' } });
  const root = res.task;
  check('原条挂了 seriesId', !!root.seriesId, JSON.stringify(root.seriesId));
  const members = M.seriesMembers(s, root.seriesId);
  check('系列里有原条 + 副本（>1 条）', members.length > 1, members.length);
  check('每条副本都带 repeatOf 和 seriesFreq', members.slice(1).every(m =>
    m.task.repeatOf === root.id && m.task.seriesFreq === 'daily'), '副本字段不全');
  check('连明天那条也算在"以后还剩几条"里', M.seriesFutureCount(s, root, TK) === members.length, M.seriesFutureCount(s, root, TK));
}

/* ================= 3. 编辑：只动用户能改的字段 ================= */
console.log('\n【3】编辑不动打卡 / 专注 / 顺序 / id');
{
  const s = makeState();
  const r = M.add(s, TK, { title: '旧标题', moduleId: 'zlfx', minutes: 30 });
  const t = r.task;
  t.status = 'done';
  t.actualMinutes = 28;
  t.focusMinutes = 12;
  t.order = 7;
  /* 顺手挂一个系列号和创建时间：编辑也不该碰这两个 */
  t.seriesId = 's-keepme';
  t.createdAt = '2026-09-01T08:00:00.000Z';
  const snapOf = (x) => JSON.stringify({
    id: x.id, status: x.status, a: x.actualMinutes, f: x.focusMinutes,
    o: x.order, sid: x.seriesId, born: x.createdAt,
  });
  const before = snapOf(t);

  M.openEdit(s, TK, t.id);
  M.setTitle('新标题');
  M.setDraft('minutes', '45');
  M.setDraft('moduleId', 'yy');
  const out = M.commitEdit(s, TK);
  check('保存成功', out.ok === true, JSON.stringify(out));
  check('标题 / 时长 / 科目改掉了', t.title === '新标题' && t.minutes === 45 && t.moduleId === 'yy',
    JSON.stringify({ t: t.title, m: t.minutes, mid: t.moduleId }));
  check('id / 打卡 / 实际 / 专注 / 顺序一个都没动',
    snapOf(t) === before, snapOf(t));
  check('系列号和创建时间也不动', t.seriesId === 's-keepme' && t.createdAt === '2026-09-01T08:00:00.000Z',
    JSON.stringify({ sid: t.seriesId, born: t.createdAt }));
  check('子任务按同名保留勾选状态', (function () {
    const s2 = makeState();
    s2.manual.settings.advanced.subtask = true;   // 子任务是"清单选项"里的开关，开着才在表单里出现
    const r2 = M.add(s2, TK, { title: 'x', moduleId: 'zlfx', subtasks: [{ title: '甲' }, { title: '乙' }] });
    const t2 = r2.task;
    t2.subtasks[0].done = true;
    M.openEdit(s2, TK, t2.id);
    M.setSub(0, '甲');
    M.setSub(1, '丙');
    M.commitEdit(s2, TK);
    return t2.subtasks.length === 2 && t2.subtasks[0].done === true && t2.subtasks[1].title === '丙';
  })(), '子任务重建错了');
}

/* ================= 4. 改一串 / 删一串：只碰未打卡的 ================= */
console.log('\n【4】系列动作只碰"今天及以后 + 没打卡"');
{
  const s = makeState();
  const r = M.add(s, TK, { title: '民法', moduleId: 'zlfx', minutes: 30, repeat: { freq: 'daily', until: '' } });
  const sid = r.task.seriesId;
  const members = M.seriesMembers(s, sid);
  /* 把今天这条打卡，把明天那条打卡（模拟历史不能改） */
  members[0].task.status = 'done';
  members[1].task.status = 'done';

  M.openEdit(s, TK, r.task.id, { scope: 'series' });
  M.setTitle('民法总则');
  const out = M.commitEdit(s, TK);
  check('改一串保存成功', out.ok === true && out.touched > 1, JSON.stringify(out));
  check('已打卡的两条一个字没改', members[0].task.title === '民法' && members[1].task.title === '民法',
    members.slice(0, 2).map(m => m.task.title).join(','));
  check('还没打卡的都跟着改了', members.slice(2).every(m => m.task.title === '民法总则'), '没同步');

  const doomed = M.dropSeriesFuture(s, sid, TK);
  check('删一串只剩"今天及以后 + 没打卡"的', doomed.length === members.length - 2, doomed.length);
  check('已打卡的两条还在', M.seriesMembers(s, sid).length === 2, M.seriesMembers(s, sid).length);
}

/* ================= 5. 复制 / 改期 ================= */
console.log('\n【5】复制一条 / 改到别的日子');
{
  const s = makeState();
  const r = M.add(s, TK, { title: '民法', moduleId: 'zlfx', minutes: 30, repeat: { freq: 'daily', until: '' } });
  const copy = M.duplicate(s, TK, r.task.id);
  check('复制出来的是新的一条', !!copy && copy.id !== r.task.id, 'id 一样');
  check('复制件不带系列号（不然会跟着原串一起被改被删）', !copy.seriesId && !copy.repeatOf, JSON.stringify(copy.seriesId));
  check('复制件是干净的待办', copy.status === 'todo' && copy.actualMinutes === null && copy.focusMinutes === 0,
    JSON.stringify({ st: copy.status, a: copy.actualMinutes, f: copy.focusMinutes }));
  check('标题跟着抄一份', copy.title === '民法', copy.title);

  const s2 = makeState();
  const a = M.add(s2, '2026-09-10', { title: 'A', moduleId: 'zlfx', minutes: 30 }).task;
  const b = M.add(s2, '2026-09-10', { title: 'B', moduleId: 'zlfx', minutes: 30 }).task;
  M.moveToDay(s2, '2026-09-10', b.id, '2026-09-12');
  check('移走了：原天只剩 A', (s2.days['2026-09-10'].tasks || []).map(t => t.id).join() === a.id,
    JSON.stringify((s2.days['2026-09-10'].tasks || []).map(t => t.title)));
  check('移过去那天有 B', (s2.days['2026-09-12'].tasks || []).map(t => t.id).join() === b.id, '没过去');
  check('两边的 order 都从 1 连续排', (s2.days['2026-09-10'].tasks || []).every(t => t.order === 1) &&
    (s2.days['2026-09-12'].tasks || []).every(t => t.order === 1), '编号不对');

  /* 已打卡的条目不给"改到别的日子"——历史不能动 */
  const s3 = makeState();
  const doneT = M.add(s3, TK, { title: '打完卡的', moduleId: 'zlfx', minutes: 30 }).task;
  doneT.status = 'done';
  const todoT = M.add(s3, TK, { title: '还没做', moduleId: 'zlfx', minutes: 30 }).task;
  M.openMenu(s3, TK, doneT.id);
  const doneMenu = M.menuHtml(s3, TK);
  M.openMenu(s3, TK, todoT.id);
  const todoMenu = M.menuHtml(s3, TK);
  check('已打卡的条目菜单里没有「改到别的日子」', doneMenu.indexOf('改到别的日子') === -1, '还给了改期');
  check('没打卡的条目菜单里给了「改到别的日子」', todoMenu.indexOf('改到别的日子') >= 0, '没给改期');
  check('但删除仍然给（删错了可以撤销）', doneMenu.indexOf('m-del') >= 0, '连删除都没了');
}

/* ================= 6. 批量排 ================= */
console.log('\n【6】批量排：普通清单条目 + 跳过休息日');
{
  const s = makeState();
  M.openBatch(s);
  M.setBatchField('tagId', 'zlfx');
  M.setBatchField('weeks', 2);
  M.setBatchField('amount', 10);   // 一天 10 组，肯定超过"工作日 180 分钟"的目标
  M.toggleBatchDay(6);           // 加周六
  M.toggleBatchDay(0);           // 再加周日（它是休息日，应该被跳过）
  const days = M.batchDays(s, TK);
  check('排的日子里没有休息日', days.every(k => E.parseKey(k).getDay() !== 0), JSON.stringify(days));
  check('两周里周一~周六一共 12 天（周日跳过）', days.length === 12, days.length);

  const res = M.applyBatchNow(s, TK);
  check('排进去了', !!res && res.made === 12, JSON.stringify(res));
  const first = s.days[days[0]].tasks[0];
  check('写出来的是普通清单条目', first.kind === 'task' && first.userAdded === true && !!first.work,
    JSON.stringify({ k: first.kind, u: first.userAdded, w: first.work }));
  check('科目和预计时长都带上了', first.moduleId === 'zlfx' && first.minutes > 0,
    JSON.stringify({ m: first.moduleId, min: first.minutes }));
  check('排完超过当天目标的天数会报出来', res.over === 12, JSON.stringify(res));
}

/* ================= 7. 每天目标 ================= */
console.log('\n【7】每天目标：工作日和周末取不同的数');
{
  const s = makeState();
  check('周五（工作日）取 weekdayMinutes', M.dailyTarget(s, '2026-09-11') === 180, M.dailyTarget(s, '2026-09-11'));
  check('周六取 weekendMinutes', M.dailyTarget(s, '2026-09-12') === 360, M.dailyTarget(s, '2026-09-12'));
}

console.log('');
console.log(fail ? ('结果：' + fail + ' 处不对') : '全部通过 ✅');
process.exit(fail ? 1 : 0);
