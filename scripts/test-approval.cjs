const { spawnSync } = require('child_process');
const homedir = require('os').homedir();
const fs = require('fs');
const codex = homedir + '/.vscode/extensions/openai.chatgpt-26.527.31454-win32-x64/bin/windows-x86_64/codex.exe';

// Find small session
const sessions = [];
function walk(dir, depth) {
  if (depth > 4) return;
  try { for (const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=dir+'/'+e.name; if(e.isDirectory()) walk(p,depth+1); else if(e.isFile()&&e.name.endsWith('.jsonl')){const s=fs.statSync(p);sessions.push({path:p,size:s.size})};} } catch {}
}
walk(homedir+'/.codex/sessions',0);
sessions.sort((a,b)=>a.size-b.size);
const t=sessions.find(s=>s.size>2000&&s.size<50000);
const m=JSON.parse(fs.readFileSync(t.path,'utf8').split('\n').find(l=>l.trim()));
const sid=m.payload?.id||m.id;

// Method 1: --ask-for-approval BEFORE resume (exec level arg)
const args1 = [
  'exec',
  '--dangerously-bypass-hook-trust',
  '--sandbox', 'danger-full-access',
  '--ask-for-approval', 'on-request',
  'resume', sid,
  '--json', 'Run echo hello',
];

console.log('Method 1 (--ask-for-approval before resume):');
const r1 = spawnSync(codex, args1, { cwd: 'F:/Work/Codekey', timeout: 30000, encoding: 'utf8' });
if (r1.stdout) r1.stdout.split('\n').slice(0,10).forEach(l => console.log(l));
console.log('EXIT:', r1.status);

if (r1.status !== 0) {
  // Method 2: try with -c instead
  console.log('\nMethod 2 (-c approval_policy):');
  const args2 = [
    'exec',
    '--dangerously-bypass-hook-trust',
    '--sandbox', 'danger-full-access',
    '-c', 'approval_policy="on-request"',
    'resume', sid,
    '--json', 'Run echo hello',
  ];
  const r2 = spawnSync(codex, args2, { cwd: 'F:/Work/Codekey', timeout: 30000, encoding: 'utf8' });
  if (r2.stdout) r2.stdout.split('\n').slice(0,10).forEach(l => console.log(l));
  console.log('EXIT:', r2.status);
}
