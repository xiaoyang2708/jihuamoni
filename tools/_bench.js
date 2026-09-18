const fs=require("fs"),path=require("path"),vm=require("vm");
const ROOT=path.join(__dirname,"..");
const sb={console,Date,Math,JSON,isFinite};sb.window=sb;vm.createContext(sb);
["js/config.js","js/engine.js"].forEach(f=>vm.runInContext(fs.readFileSync(path.join(ROOT,f),"utf8"),sb,{filename:f}));
const YT=sb.window.YT,E=YT.engine;
function plan(months,T,force){
  YT.CONFIG.stage.readySetsPerModule=T;
  YT.CONFIG.stage.forceSprintDays=force;
  const today=new Date(2026,8,18);
  const exam=new Date(today.getFullYear(),today.getMonth(),today.getDate());
  exam.setDate(exam.getDate()+Math.round(months*30));
  const profile={examDate:E.toKey(exam),base:"zero",weekdayMinutes:180,weekendMinutes:420,restDays:[0],lessonMinutes:150,speed:1.5,courseUnits:{},benchmarks:{},strength:{}};
  YT.MODULES.forEach(m=>{profile.courseUnits[m.id]=m.courseUnits;profile.strength[m.id]="normal";});
  const s={profile,roadmap:null,days:{},scores:[]};
  const tk=E.toKey(today);
  s.roadmap=E.buildRoadmap(profile,tk);
  E.ensureAhead(s,tk,400);
  const keys=Object.keys(s.days).sort().filter(k=>!s.days[k].isRest);
  const first={},count={};
  keys.forEach(k=>{const st=s.days[k].stage; if(!first[st])first[st]=k; count[st]=(count[st]||0)+1;});
  return count;
}
[4,6].forEach(m=>{
  console.log("\n=== "+m+" 个月（冲刺上限 30 天）===");
  [20,30,40,50,80].forEach(T=>{
    const c=plan(m,T,30);
    console.log("  阈值"+String(T).padStart(4)+"组   基础"+String(c.base||0).padStart(3)+" / 强化"+String(c.strengthen||0).padStart(3)+" / 冲刺"+String(c.sprint||0).padStart(3));
  });
});
