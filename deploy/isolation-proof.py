"""Disposable-image proof. Never run against an operator's production home."""
import json, os, pwd, socket, stat, subprocess, sys
from pathlib import Path
assert os.geteuid() == 0
home=Path('/opt/data'); state=home/'.hob'; private=Path('/var/lib/hob-isolation')
registry=json.loads((private/'users.json').read_text())['bots']
active=[row['name'] for row in json.loads((state/'bots.json').read_text())['bots'] if row['state']=='active']
assert 'default' in active and 'proactive-worker' in active
app=pwd.getpwnam('hermes'); seen=set()
def shell(name, code):
 uid=registry[name]['uid']; user='hob'+str(uid)
 return subprocess.run(['/usr/bin/ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-p','22220','-i',str(state/'isolation-keys'/(name+'.key')),user+'@127.0.0.1',code],user=app.pw_uid,group=app.pw_gid,extra_groups=[],env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(home)},capture_output=True,timeout=20,text=True)
for name in active:
 row=registry[name]; uid=row['uid']; assert uid != app.pw_uid and uid not in seen and uid>=20000; seen.add(uid)
 result=shell(name,'id -u'); assert result.returncode==0, 'SSH unavailable: '+result.stderr[:400]; assert int(result.stdout.strip())==uid
 work=home/'workspaces'/('main' if name=='default' else 'bots/'+name)
 assert work.stat().st_uid==uid
 assert shell(name,'test -r '+str(work/'.hob/relay.json')).returncode==0, 'own relay key unreadable'
 for forbidden in [state/'listener-auth.json', state/'bots.json', state/'isolation-keys'/(name+'.key'), home/'gateway.sock']:
  assert shell(name,'test -r '+str(forbidden)).returncode!=0, 'operator state accessible'
 for other in active:
  if name==other: continue
  browser_rows=json.loads((state/'browsers.json').read_text())['browsers']
  for browser in browser_rows:
   if browser['bot'] != other: continue
   cookie_dir=state/'browsers'/other/browser['browserProfileId']/'chromium'
   assert shell(name,'test -r '+str(cookie_dir)).returncode!=0, 'cross-bot browser directory readable'
  otherwork=home/'workspaces'/('main' if other=='default' else 'bots/'+other)
  assert shell(name,'test -r '+str(otherwork/'.hob/relay.json')).returncode!=0, 'cross-bot relay readable'
  assert shell(name,'test -w '+str(otherwork)).returncode!=0, 'cross-bot workspace writable'
 # Real kernel credentials deny direct broker access even when its path is known.
 denied=subprocess.run(['/usr/bin/python3','-c',"import socket; s=socket.socket(socket.AF_UNIX); s.connect('/run/hob-isolation/broker.sock')"],user=uid,group=uid,extra_groups=[],capture_output=True,timeout=10)
 assert denied.returncode!=0, 'bot reached privileged broker'
# Prove Chromium's namespace/seccomp sandbox under an actual isolated UID.
first=registry['default']['uid']
sandbox=subprocess.run(['/usr/local/bin/node','/app/deploy/probe-browser.mjs'],user=first,group=first,extra_groups=[],env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(home/'workspaces/main')},capture_output=True,text=True,timeout=60)
assert sandbox.returncode==0, 'isolated Chromium sandbox failed: '+sandbox.stderr[-1200:]
assert sandbox.stdout.startswith('SANDBOX_OK '), 'missing sandbox proof'
# Existing Chrome processes must use an assigned bot UID, never the operator/root.
chrome=[]
for entry in Path('/proc').iterdir():
 if not entry.name.isdigit(): continue
 try:
  args=(entry/'cmdline').read_bytes().split(bytes([0])); image=Path(os.fsdecode(args[0])).name
  if image not in ('chrome','chromium','headless_shell'): continue
  uid=int(next(line for line in (entry/'status').read_text().splitlines() if line.startswith('Uid:')).split()[1])
  assert uid in seen, 'Chromium runs outside bot UID'; assert b'--no-sandbox' not in args and b'--remote-debugging-port=0' not in args
  chrome.append(uid)
 except (FileNotFoundError,ProcessLookupError): pass
assert chrome, 'managed Chromium was not exercised'
print(json.dumps({'isolatedProfiles':len(active),'uids':sorted(seen),'chromiumUids':sorted(set(chrome)),'crossBotDenied':True,'operatorSecretsDenied':True,'brokerDenied':True}))
