"""Kernel ACL regression proof in the disposable Linux image."""
import importlib.util, os, subprocess, tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('broker',Path(__file__).with_name('isolation-broker.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='hob-acl-') as root:
 fd=os.open(root,m.DIR_FLAGS)
 try:
  m.acl(fd,'u:20000:--x','g::---','o::---')
  m.acl(fd,'u:20000:---','g::---','o::---',default=True)
  state=subprocess.run(['/usr/bin/getfacl','-cpn',root],check=True,capture_output=True,text=True).stdout.splitlines()
  assert 'user:20000:--x' in state, 'default ACL overwrote parent traversal'
  assert 'default:user:20000:---' in state, 'new private files need a default deny'
  # A new child inherits the deny; changing access on it retains that default.
  child=Path(root)/'workspace';child.mkdir()
  childfd=os.open(child,m.DIR_FLAGS)
  try:
   m.acl(childfd,'u:20000:rwx')
   state=subprocess.run(['/usr/bin/getfacl','-cpn',str(child)],check=True,capture_output=True,text=True).stdout.splitlines()
   assert 'user:20000:rwx' in state
   assert 'default:user:20000:---' in state
  finally:os.close(childfd)
 finally:os.close(fd)
print('Linux access/default ACL separation verified')
