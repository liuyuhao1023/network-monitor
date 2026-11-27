import json,sys,os,re,uuid,subprocess,shutil,datetime,time,xml.etree.ElementTree as E
import libvirt
try: libvirt.registerErrorHandler(lambda ctx, err: None, None)
except Exception: pass

ROOT='/var/lib/libvirt/images/network-monitor'
ISO_DEFAULT=ROOT+'/iso'
DEFAULT_BACKUP_DIR='/mnt/raid10/vm-backups'
os.makedirs(ISO_DEFAULT,exist_ok=True)

def fail(s): raise ValueError(s)

def integer(v,lo,hi):
 if type(v)!=int or not lo<=v<=hi: fail('资源参数超出允许范围')
 return v

def get_datastores():
 stores=[]
 configs=[
  {'id':'datastore1','name':'datastore1 (系统 SSD)','mount':'/','type':'SSD (系统盘)','fs':'ext4','path':ROOT,'isoDir':ROOT+'/iso','isDefault':False},
  {'id':'datastore-ssd','name':'datastore-ssd (高速 SSD)','mount':'/mnt/vadata','type':'SSD (高速数据盘)','fs':'ext4','path':'/mnt/vadata/vm-storage','isoDir':'/mnt/vadata/iso','isDefault':False},
  {'id':'datastore-raid10','name':'datastore-raid10 (大容量阵列)','mount':'/mnt/raid10','type':'RAID 10 (4 盘位)','fs':'ext4','path':'/mnt/raid10/vm-storage','isoDir':'/mnt/raid10/iso','isDefault':True}
 ]
 for c in configs:
  if os.path.exists(c['mount']):
   try:
    st=shutil.disk_usage(c['mount'])
    os.makedirs(c['path'],exist_ok=True)
    os.makedirs(c['isoDir'],exist_ok=True)
    stores.append({
     **c,
     'totalGiB':round(st.total/1073741824,1),
     'freeGiB':round(st.free/1073741824,1),
     'usedGiB':round((st.total-st.free)/1073741824,1),
     'usedPercent':round((st.total-st.free)/st.total*100,1) if st.total else 0
    })
   except Exception: pass
 return stores

def get_iso_dirs():
 dirs=[ISO_DEFAULT]
 for s in get_datastores():
  if s.get('isoDir') and s['isoDir'] not in dirs:
   dirs.append(s['isoDir'])
 return dirs

def iso_path(name,datastore_id=None):
 low=name.lower() if isinstance(name,str) else ''
 if not isinstance(name,str) or '/' in name or '\\' in name or not (low.endswith('.iso') or low.endswith('.img') or low.endswith('.qcow2') or low.endswith('.vmdk') or low.endswith('.raw')): fail('无效镜像/固件文件名')
 for s in get_datastores():
  if datastore_id and s['id']!=datastore_id: continue
  p=os.path.join(s['isoDir'],name)
  if os.path.isfile(p): return p
 fail(f'镜像文件 {name} 不存在于所选数据存储中')

def get_all_isos(usage=None):
 if usage is None: usage={}
 isos=[]
 for s in get_datastores():
  iso_dir=s['isoDir']
  if not os.path.isdir(iso_dir): continue
  for f in sorted(os.listdir(iso_dir)):
   low=f.lower()
   if not (low.endswith('.iso') or low.endswith('.img') or low.endswith('.qcow2') or low.endswith('.vmdk') or low.endswith('.raw')):
    continue
   p=os.path.join(iso_dir,f)
   if os.path.isfile(p) and not os.path.islink(p):
    st=os.stat(p)
    is_iso=low.endswith('.iso')
    isos.append({
     'name':f,
     'path':p,
     'datastore':s['id'],
     'datastoreName':s['name'],
     'size':st.st_size,
     'modified':int(st.st_mtime),
     'imageType':'iso' if is_iso else 'firmware',
     'format':'iso' if is_iso else ('qcow2' if low.endswith('.qcow2') else ('vmdk' if low.endswith('.vmdk') else 'raw')),
     'usedBy':sorted(usage.get(f,[]))
    })
 return isos

def resources(r):
 cpu=integer(r.get('cpu'),1,os.cpu_count())
 ram=integer(r.get('memory'),512,max(512,int(os.sysconf('SC_PAGE_SIZE')*os.sysconf('SC_PHYS_PAGES')/1048576)-2048))
 return cpu,ram

def detect_dev_speed_duplex(dev_name):
 sp=1000; dup='full'
 if dev_name:
  try:
   p=f'/sys/class/net/{dev_name}/speed'
   if os.path.isfile(p):
    v=int(open(p).read().strip())
    if v>0: sp=v
  except Exception: pass
  try:
   p=f'/sys/class/net/{dev_name}/duplex'
   if os.path.isfile(p):
    d=open(p).read().strip().lower()
    if d in ['full','half']: dup=d
  except Exception: pass
 return sp, dup

def sync_domain_net_speed(d, c=None):
 try:
  x=E.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
  nics=x.findall('./devices/interface')
  if nics:
   x.set('xmlns:qemu', 'http://libvirt.org/schemas/domain/qemu/1.0')
   for el in x.findall('{http://libvirt.org/schemas/domain/qemu/1.0}override'): x.remove(el)
   qovr=E.SubElement(x, '{http://libvirt.org/schemas/domain/qemu/1.0}override')
   for idx, nic in enumerate(nics):
    alias_el=nic.find('alias')
    alias_name=alias_el.get('name') if alias_el is not None and alias_el.get('name') else f'net{idx}'
    src=nic.find('source')
    dev_name=src.get('dev') if src is not None else None
    if dev_name:
     sp, dup=detect_dev_speed_duplex(dev_name)
     qdev=E.SubElement(qovr, '{http://libvirt.org/schemas/domain/qemu/1.0}device', alias=alias_name)
     qfe=E.SubElement(qdev, '{http://libvirt.org/schemas/domain/qemu/1.0}frontend')
     E.SubElement(qfe, '{http://libvirt.org/schemas/domain/qemu/1.0}property', name='speed', type='signed', value=str(sp))
     E.SubElement(qfe, '{http://libvirt.org/schemas/domain/qemu/1.0}property', name='duplex', type='string', value=dup)
   conn=c or d.connect()
   conn.defineXML(E.tostring(x, encoding='unicode'))
 except Exception: pass


def get_network_interfaces():
 interfaces=[]
 try:
  out=subprocess.check_output(['ip','-j','addr'])
  data=json.loads(out)
  for iface in data:
   name=iface.get('ifname')
   if name in ['lo','virbr0'] or name.startswith('vnet') or name.startswith('macvtap') or name.startswith('macvlan'): continue
   addrs=[a.get('local') for a in iface.get('addr_info',[]) if a.get('family')=='inet']
   operstate=iface.get('operstate','UNKNOWN')
   is_mgmt='192.168.1.241' in addrs
   carrier_path=f'/sys/class/net/{name}/carrier'
   carrier='0'
   if os.path.exists(carrier_path):
    try:
     with open(carrier_path) as cf: carrier=cf.read().strip()
    except Exception: pass
   link_desc='主管理口 · 10G已连线 192.168.1.x' if is_mgmt else ('网线已连线 · 10G' if carrier=='1' else '未插网线 · 离线')
   interfaces.append({
    'name':name,
    'ips':addrs,
    'state':operstate,
    'carrier':carrier=='1',
    'isDefault':is_mgmt,
    'desc':f"{name} ({link_desc})"
   })
 except Exception: pass
 return interfaces

def describe(d):
 x=E.fromstring(d.XMLDesc());info=d.info();disks=[]
 for disk in x.findall('./devices/disk'):
  src=disk.find('source');target=disk.find('target');driver=disk.find('driver')
  path_val=src.get('file','') if src is not None and src.get('file') else (src.get('dev','') if src is not None else '')
  serial_val=disk.find('serial').text if disk.find('serial') is not None else ''
  # find which datastore
  ds_name='物理直通' if disk.get('type')=='block' else '本地存储'
  for ds in get_datastores():
   if path_val and path_val.startswith(ds['mount']) and ds['mount']!='/': ds_name=ds['name']; break
   elif path_val and path_val.startswith(ROOT): ds_name='datastore1 (系统 SSD)'; break
  t_dev=target.get('dev','') if target is not None else ''
  cap_gib=0.0;alloc_gib=0.0
  try:
   if d.isActive() and t_dev:
    binfo=d.blockInfo(t_dev)
    cap_gib=round(binfo[0]/(1024**3),1)
    alloc_gib=round(binfo[1]/(1024**3),1)
  except Exception: pass
  if not cap_gib and path_val and os.path.exists(path_val):
   try:
    if path_val.startswith('/dev/'):
     with open(path_val,'rb') as bf:
      bf.seek(0,2)
      cap_gib=round(bf.tell()/(1024**3),1)
      alloc_gib=cap_gib
    else:
     out=subprocess.check_output(['qemu-img','info','--output=json',path_val],timeout=3)
     ij=json.loads(out)
     cap_gib=round(ij.get('virtual-size',0)/(1024**3),1)
     alloc_gib=round(ij.get('actual-size',os.path.getsize(path_val))/(1024**3),1)
   except Exception: pass
  disks.append({
   'device':disk.get('device'),
   'type':disk.get('type'),
   'target':t_dev,
   'path':path_val,
   'serial':serial_val,
   'datastore':ds_name,
   'capacityGiB':cap_gib,
   'allocationGiB':alloc_gib,
   'driver':driver.get('type','') if driver is not None else ''
  })
 ips=[]
 try:
  for iface in d.interfaceAddresses(libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_LEASE).values():
   ips += [a['addr'] for a in iface.get('addrs',[])]
 except Exception: pass
 try:
  for iface in d.interfaceAddresses(libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT).values():
   ips += [a['addr'] for a in iface.get('addrs',[]) if a.get('addr') and not a['addr'].startswith('127.') and not a['addr'].startswith('fe80:')]
 except Exception: pass
 ifaces=[]
 for iface in x.findall('./devices/interface'):
  itype=iface.get('type')
  src=iface.find('source')
  model=iface.find('model')
  mac=iface.find('mac')
  s_val=src.get('dev') or src.get('network') or src.get('bridge','') if src is not None else ''
  m_val=src.get('mode','') if src is not None else ''
  ifaces.append({
   'type':itype,
   'source':s_val,
   'mode':m_val,
   'model':model.get('type','') if model is not None else '',
   'mac':mac.get('address','') if mac is not None else ''
  })
 has_agent = False
 try:
  agent_addrs = d.interfaceAddresses(libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT)
  if agent_addrs: has_agent = True
 except Exception: pass

 if not ips and d.isActive():
  # 1. /proc/net/arp
  try:
   if os.path.exists('/proc/net/arp'):
    with open('/proc/net/arp', 'r') as f_arp:
     for line in f_arp:
      parts = line.split()
      if len(parts) >= 4 and parts[2] in ('0x2', '0x6'):
       arp_ip, arp_mac = parts[0], parts[3].lower()
       for iface in ifaces:
        if iface.get('mac', '').lower() == arp_mac and arp_ip not in ips and not arp_ip.startswith('127.'):
         ips.append(arp_ip)
  except Exception: pass

  # 2. ip neigh show
  if not ips:
   try:
    out = subprocess.check_output(['ip', 'neigh', 'show']).decode()
    for iface in ifaces:
     m = (iface.get('mac') or '').lower()
     if m:
      for line in out.splitlines():
       if m in line.lower() and ('REACHABLE' in line or 'STALE' in line or 'DELAY' in line):
        p = line.split()
        if p and re.match(r'^\d+\.\d+\.\d+\.\d+$', p[0]) and p[0] not in ips:
         ips.append(p[0])
   except Exception: pass

 cache_file = '/tmp/vm-ip-cache.json'
 ip_cache = {}
 try:
  if os.path.exists(cache_file):
   with open(cache_file, 'r') as f_c: ip_cache = json.load(f_c)
 except Exception: pass

 for iface in ifaces:
  m = (iface.get('mac') or '').lower()
  if m and ips:
   ip_cache[m] = ips[0]
 for ip in ips:
  if ip.startswith('192.168.1.') and ip not in ('192.168.1.241', '192.168.1.240', '192.168.1.1'):
   try: subprocess.run(['ip', 'route', 'replace', f'{ip}/32', 'dev', 'macvlan-host'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
   except Exception: pass

 if not ips and d.isActive():
  for iface in ifaces:
   m = (iface.get('mac') or '').lower()
   cached_ip = ip_cache.get(m)
   if cached_ip:
    try:
     subprocess.run(['ping', '-c', '1', '-W', '1', '-I', 'macvlan-host', cached_ip], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
     try: subprocess.run(['ping', '-c', '1', '-W', '1', cached_ip], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
     except Exception: pass
    ips.append(cached_ip)

 try:
  with open(cache_file, 'w') as f_c: json.dump(ip_cache, f_c)
  try: os.chmod(cache_file, 0o666)
  except Exception: pass
 except Exception: pass
 sys_d=next((dk for dk in disks if dk.get('device')=='disk' and dk.get('type')=='file'), None)
 disk_size=int(round(sys_d['capacityGiB'])) if sys_d and sys_d.get('capacityGiB') else 32
 cfg_x=E.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
 cfg_cpu_el=cfg_x.find('vcpu')
 cfg_cpu=int(cfg_cpu_el.text) if cfg_cpu_el is not None and cfg_cpu_el.text else info[3]
 cfg_mem_el=cfg_x.find('currentMemory') if cfg_x.find('currentMemory') is not None else cfg_x.find('memory')
 cfg_mem=(int(cfg_mem_el.text)//1024) if cfg_mem_el is not None and cfg_mem_el.text else (info[2]//1024)
 cfg_ifaces=[]
 for iface in cfg_x.findall('./devices/interface'):
  itype=iface.get('type')
  src=iface.find('source')
  model=iface.find('model')
  mac=iface.find('mac')
  s_val=src.get('dev') or src.get('network') or src.get('bridge','') if src is not None else ''
  m_val=src.get('mode','') if src is not None else ''
  cfg_ifaces.append({
   'type':itype,
   'source':s_val,
   'mode':m_val,
   'model':model.get('type','') if model is not None else '',
   'mac':mac.get('address','') if mac is not None else ''
  })
 final_ifaces=cfg_ifaces if cfg_ifaces else ifaces
 return {'id':d.UUIDString(),'name':d.name(),'state':info[0],'hasAgent':has_agent,'memory':cfg_mem,'liveMemory':info[2]//1024,'cpu':cfg_cpu,'liveCpu':info[3],'diskSize':disk_size,'autostart':bool(d.autostart()),'ips':ips,'disks':disks,'interfaces':final_ifaces,'liveInterfaces':ifaces}

def ensure_backup_dir(target_dir):
 p=os.path.realpath(target_dir or DEFAULT_BACKUP_DIR)
 os.makedirs(p,exist_ok=True)
 try:
  shutil.chown(p,user='libvirt-qemu',group='kvm')
  os.chmod(p,0o775)
 except Exception: pass
 return p

def get_system_disk(d,inactive=False):
 flag=libvirt.VIR_DOMAIN_XML_INACTIVE if(inactive or not d.isActive()) else 0
 x=E.fromstring(d.XMLDesc(flag))
 for disk in x.findall('./devices/disk'):
  if disk.get('device')=='disk' and disk.get('type')=='file':
   src=disk.find('source');target=disk.find('target');driver=disk.find('driver')
   if src is not None and src.get('file'):
    return {
     'targetDev':target.get('dev','sda') if target is not None else 'sda',
     'path':os.path.realpath(src.get('file')),
     'driverType':driver.get('type','qcow2') if driver is not None else 'qcow2'
    }
 fail('未找到该虚拟机的系统盘 (QCOW2 镜像)')

def list_backups(target_dir,vm_id=None):
 p=os.path.realpath(target_dir or DEFAULT_BACKUP_DIR)
 if not os.path.isdir(p): return {'backups':[],'targetDir':p,'freeGiB':0}
 results=[]
 for f in os.listdir(p):
  if f.endswith('.qcow2'):
   meta_path=os.path.join(p,f+'.meta.json')
   qcow_path=os.path.join(p,f)
   size=os.path.getsize(qcow_path) if os.path.exists(qcow_path) else 0
   mtime=int(os.path.getmtime(qcow_path))
   meta=None
   if os.path.isfile(meta_path):
    try:
     with open(meta_path,'r',encoding='utf-8') as mf: meta=json.load(mf)
    except Exception: pass
   if not meta:
    parts=f[:-6].split('_')
    meta={'id':f[:-6],'vmId':'','vmName':parts[0] if parts else 'Unknown','filename':f,'filePath':qcow_path,'targetDir':p,'size':size,'createdAt':datetime.datetime.fromtimestamp(mtime).isoformat(),'type':'manual','note':''}
   else:
    meta['size']=size
    meta['filePath']=qcow_path
   if vm_id and meta.get('vmId') and meta.get('vmId')!=vm_id: continue
   results.append(meta)
 results.sort(key=lambda x:x.get('createdAt',''),reverse=True)
 free_gib=round(shutil.disk_usage(p).free/1073741824,1) if os.path.exists(p) else 0
 return {'backups':results,'targetDir':p,'freeGiB':free_gib}

def browse_datastore(ds_id):
 stores=get_datastores()
 ds=next((s for s in stores if s['id']==ds_id),None)
 if not ds: fail('数据存储不存在')
 files=[]
 for dpath in [ds['isoDir'],ds['path'],ds['mount']+'/vm-backups']:
  if os.path.isdir(dpath):
   for fname in os.listdir(dpath):
    fpath=os.path.join(dpath,fname)
    if os.path.isfile(fpath) and not os.path.islink(fpath):
     st=os.stat(fpath)
     low=fname.lower()
     if low.endswith('.iso'): ftype='ISO 安装光盘'
     elif low.endswith('.img') or low.endswith('.raw'): ftype='系统固件/母盘 (iStoreOS/RAW)'
     elif low.endswith('.qcow2'): ftype='QCOW2 虚拟磁盘'
     elif low.endswith('.vmdk'): ftype='VMDK 虚拟磁盘'
     elif low.endswith('.gz'): ftype='压缩镜像包 (GZ)'
     else: ftype='文件' 
     files.append({
      'name':fname,
      'folder':os.path.basename(dpath),
      'path':fpath,
      'size':st.st_size,
      'modified':int(st.st_mtime),
      'mtime':int(st.st_mtime),
      'type':ftype
     })
 files.sort(key=lambda x:x['modified'],reverse=True)
 return {'datastore':ds,'files':files}

def main(r):
 c=libvirt.open('qemu:///system');action=r.get('action')
 if action=='datastores':
  return get_datastores()
 if action=='datastore-browse':
  return browse_datastore(r.get('datastoreId','datastore-raid10'))
 if action=='network-interfaces':
  return get_network_interfaces()
 if action=='backup-list':
  return list_backups(r.get('targetDir'),r.get('vmId'))
 if action=='backup-delete':
  filename=r.get('filename','');target_dir=os.path.realpath(r.get('targetDir') or DEFAULT_BACKUP_DIR)
  if not filename or '/' in filename or '\\' in filename or not filename.endswith('.qcow2'): fail('无效备份文件名')
  qcow=os.path.join(target_dir,filename);meta=qcow+'.meta.json'
  if not os.path.isfile(qcow): fail('备份文件不存在')
  os.unlink(qcow)
  if os.path.isfile(meta): os.unlink(meta)
  return {'deleted':filename}
 if action in ['list','iso-delete']:
  domains=c.listAllDomains();usage={}
  iso_dirs=get_iso_dirs()
  for d in domains:
   flags=[0,libvirt.VIR_DOMAIN_XML_INACTIVE] if d.isPersistent() else [0]
   for flag in flags:
    x=E.fromstring(d.XMLDesc(flag))
    for src in x.findall('./devices/disk/source'):
     path=os.path.realpath(src.get('file',''))
     if any(os.path.dirname(path)==idir for idir in iso_dirs):
      usage.setdefault(os.path.basename(path),set()).add(d.name())
  if action=='iso-delete':
   name=r.get('name');path=r.get('path') or iso_path(name)
   if r.get('confirmation')!=name:fail('请确认要删除的镜像名称')
   if os.path.islink(path):fail('不允许删除符号链接')
   if usage.get(name):fail('镜像仍被虚拟机引用，请先卸载：'+', '.join(sorted(usage[name])))
   if os.path.isfile(path): os.unlink(path)
   return {'deleted':name}
  isos=get_all_isos(usage)
  return {
   'kvm':os.path.exists('/dev/kvm'),
   'cpus':os.cpu_count(),
   'memoryMiB':int(os.sysconf('SC_PAGE_SIZE')*os.sysconf('SC_PHYS_PAGES')/1048576),
   'freeGiB':round(shutil.disk_usage(ROOT).free/1073741824,1),
   'vms':[describe(d) for d in domains],
   'isos':isos,
   'datastores':get_datastores(),
   'networkInterfaces':get_network_interfaces()
  }
 if action=='create':
  name=r.get('name','');cpu,ram=resources(r);size=integer(r.get('disk'),1,1024)
  if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,47}',name):fail('名称仅允许字母、数字、点、短横线和下划线，最长 48 字符')
  if any(d.name()==name for d in c.listAllDomains()):fail('虚拟机名称已存在')
  # Datastore selection for VM
  ds_id=r.get('datastoreId','datastore-raid10')
  stores=get_datastores()
  target_ds=next((s for s in stores if s['id']==ds_id),stores[0])
  if size*1073741824 > shutil.disk_usage(target_ds['mount']).free - 5*1073741824:
   fail(f"{target_ds['name']} 空间不足，请选择其他存储或缩小磁盘")

  install_mode = r.get('installMode')
  if not install_mode:
   install_mode = 'firmware' if r.get('firmware') else ('iso' if r.get('iso') else 'none')
  firmware_boot = r.get('firmwareBoot', 'bios') # 'bios' | 'uefi'
  media = None
  firmware_src = None

  if install_mode == 'firmware':
   fw_name = r.get('firmware') or r.get('firmwareImage') or r.get('iso')
   if not fw_name: fail('请选择固件/母盘镜像 (如 iStoreOS .img / .qcow2)')
   if r.get('firmwarePath') and os.path.isfile(r['firmwarePath']): firmware_src = r['firmwarePath']
   else: firmware_src = iso_path(fw_name)
   if not os.path.isfile(firmware_src): fail(f'固件母盘镜像文件 {fw_name} 不存在')
  elif install_mode == 'iso':
   if r.get('iso'):
    if r.get('isoPath') and os.path.isfile(r['isoPath']): media = r['isoPath']
    else: media = iso_path(r['iso'])

  net_mode=r.get('networkMode','bridge')
  net_dev=r.get('networkDev','enp8s0f1')
  ident=str(uuid.uuid4())
  disk=os.path.join(target_ds['path'],ident+'.qcow2')

  if install_mode == 'firmware':
   # Clone and convert firmware source image into target QCOW2 system disk, then resize
   try:
    subprocess.run(['qemu-img','convert','-O','qcow2',firmware_src,disk],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['qemu-img','resize',disk,str(size)+'G'],check=True,stdout=subprocess.DEVNULL)
   except Exception as e:
    if os.path.exists(disk): os.unlink(disk)
    fail('固件母盘写入或扩容失败: ' + str(e))
  else:
   subprocess.run(['qemu-img','create','-f','qcow2',disk,str(size)+'G'],check=True,stdout=subprocess.DEVNULL)
  os.chmod(disk,0o660);shutil.chown(disk,user='libvirt-qemu',group='kvm')

  x=E.Element('domain',type='kvm');E.SubElement(x,'name').text=name;E.SubElement(x,'uuid').text=ident
  E.SubElement(x,'memory',unit='MiB').text=str(ram);E.SubElement(x,'currentMemory',unit='MiB').text=str(ram);E.SubElement(x,'vcpu').text=str(cpu)
  if firmware_boot == 'uefi':
   o=E.SubElement(x,'os',firmware='efi')
  else:
   o=E.SubElement(x,'os')
  E.SubElement(o,'type',arch='x86_64',machine='q35').text='hvm'
  if install_mode == 'firmware':
   E.SubElement(o,'boot',dev='hd')
  elif install_mode == 'iso' and media:
   E.SubElement(o,'boot',dev='cdrom')
   E.SubElement(o,'boot',dev='hd')
  else:
   E.SubElement(o,'boot',dev='hd')
   E.SubElement(o,'boot',dev='cdrom')
  E.SubElement(o,'bootmenu',enable='yes')
  f=E.SubElement(x,'features');E.SubElement(f,'acpi');E.SubElement(f,'apic');E.SubElement(x,'cpu',mode='host-passthrough');E.SubElement(x,'on_reboot').text='restart';E.SubElement(x,'on_crash').text='destroy'
  devices=E.SubElement(x,'devices');E.SubElement(devices,'emulator').text='/usr/bin/qemu-system-x86_64'
  for kind,target,source in [('disk','sda',disk),('cdrom','sdb',media)]:
   el=E.SubElement(devices,'disk',type='file',device=kind);E.SubElement(el,'driver',name='qemu',type='qcow2' if kind=='disk' else 'raw')
   if source:E.SubElement(el,'source',file=source)
   E.SubElement(el,'target',dev=target,bus='sata')
   if kind=='cdrom':E.SubElement(el,'readonly')
  interfaces_req = r.get('interfaces')
  if not interfaces_req or not isinstance(interfaces_req, list):
   net_mode=r.get('networkMode','bridge')
   net_dev=r.get('networkDev','enp8s0f1')
   interfaces_req=[{'mode':net_mode,'dev':net_dev}]

  for idx, iface in enumerate(interfaces_req):
   m=iface.get('mode','bridge')
   dev_n=iface.get('dev') or 'enp8s0f1'
   if m=='nat':
    nic=E.SubElement(devices,'interface',type='network')
    E.SubElement(nic,'source',network='default')
    E.SubElement(nic,'model',type='virtio')
   elif m=='passthrough':
    nic=E.SubElement(devices,'interface',type='direct')
    E.SubElement(nic,'source',dev=dev_n,mode='passthrough')
    E.SubElement(nic,'model',type='virtio')
   else:
    nic=E.SubElement(devices,'interface',type='direct')
    E.SubElement(nic,'source',dev=dev_n,mode='bridge')
    E.SubElement(nic,'model',type='virtio')
   if iface.get('mac'):
    E.SubElement(nic,'mac',address=iface['mac'])
  E.SubElement(devices,'graphics',type='vnc',port='-1',autoport='yes',listen='127.0.0.1');video=E.SubElement(devices,'video');E.SubElement(video,'model',type='vga');E.SubElement(devices,'input',type='tablet',bus='usb')
  try:d=c.defineXML(E.tostring(x,encoding='unicode'))
  except Exception:
   os.unlink(disk);raise
  return describe(d)
 ident=r.get('id','')
 if re.fullmatch(r'[0-9a-fA-F-]{36}',ident):
  d=c.lookupByUUIDString(ident)
 else:
  try: d=c.lookupByName(ident)
  except Exception: fail('无效虚拟机 ID 或名称: '+str(ident))
 if action=='start':
  sync_domain_net_speed(d, c)
  d.create()
 elif action=='shutdown':d.shutdown()
 elif action=='reboot':
  if d.isActive():
   try: d.destroy()
   except Exception: pass
   time.sleep(1)
  sync_domain_net_speed(d, c)
  d.create()
 elif action=='reset':d.reset(0)
 elif action=='pause':d.suspend()
 elif action=='resume':d.resume()
 elif action=='stats':
  if not d.isActive(): return {'active':False,'cpuUsage':0,'memPercent':0}
  c_time=0
  try:
   cs=d.getCPUStats(True)
   if cs: c_time=cs[0].get('cpu_time',0)
  except Exception: pass
  m_info=d.memoryStats()
  return {'active':True,'cpuTime':c_time,'memoryActualMiB':m_info.get('actual',0)//1024,'memoryRssMiB':m_info.get('rss',0)//1024,'state':d.state()[0]}
 elif action=='clone':
  if d.isActive(): fail('为确保存储数据一致性，请先关闭虚拟机再执行克隆')
  new_name=r.get('newName','').strip()
  if not new_name or not re.match(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$',new_name): fail('无效的新虚拟机名称')
  if new_name in [dom.name() for dom in c.listAllDomains()]: fail('已存在同名虚拟机: '+new_name)
  ds_id=r.get('datastoreId','datastore-raid10')
  target_ds=next((s for s in get_datastores() if s['id']==ds_id),None) or get_datastores()[0]
  new_id=str(uuid.uuid4())
  new_disk=os.path.join(target_ds['path'],f'{new_id}.qcow2')
  sys_disk=get_system_disk(d,inactive=True)
  subprocess.run(['qemu-img','convert','-O','qcow2',sys_disk['path'],new_disk],check=True)
  shutil.chown(new_disk,user='libvirt-qemu',group='kvm')
  os.chmod(new_disk,0o660)
  x=E.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
  x.find('name').text=new_name
  x.find('uuid').text=new_id
  for disk_el in x.findall('./devices/disk'):
   target_el=disk_el.find('target')
   if target_el is not None and target_el.get('dev')==sys_disk['targetDev']:
    src_el=disk_el.find('source')
    if src_el is not None: src_el.set('file',new_disk)
  for nic in x.findall('./devices/interface'):
   mac_el=nic.find('mac')
   if mac_el is not None:
    mac_el.set('address',f'52:54:00:{os.urandom(1).hex()}:{os.urandom(1).hex()}:{os.urandom(1).hex()}')
  try:
   new_dom=c.defineXML(E.tostring(x,encoding='unicode'))
   return describe(new_dom)
  except Exception as e:
   if os.path.exists(new_disk): os.unlink(new_disk)
   fail('克隆配置定义失败: '+str(e))
 elif action=='edit-settings':
  sys_disk=get_system_disk(d)
  if 'diskSize' in r and r['diskSize'] and sys_disk:
   try:
    new_size_gib=int(r['diskSize'])
    curr_cap_gib=0
    if d.isActive():
     binfo=d.blockInfo(sys_disk['targetDev'])
     curr_cap_gib=int(round(binfo[0]/(1024**3)))
    else:
     out=subprocess.check_output(['qemu-img','info','--output=json',sys_disk['path']],timeout=3)
     curr_cap_gib=int(round(json.loads(out).get('virtual-size',0)/(1024**3)))
    if new_size_gib < curr_cap_gib:
     fail(f'新磁盘容量 ({new_size_gib} GiB) 不能小于当前容量 ({curr_cap_gib} GiB)，缩减磁盘可能导致数据损坏')
    elif new_size_gib > curr_cap_gib:
     if d.isActive():
      d.blockResize(sys_disk['targetDev'],new_size_gib*1024*1024,0)
     else:
      subprocess.run(['qemu-img','resize',sys_disk['path'],f'{new_size_gib}G'],check=True)
   except Exception as de:
    if '不能小于' in str(de): raise de
    fail('调整磁盘容量失败: '+str(de))
  x=E.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
  if 'cpu' in r:
   cpu=integer(r['cpu'],1,os.cpu_count());x.find('vcpu').text=str(cpu)
  if 'memory' in r:
   ram=integer(r['memory'],512,max(512,int(os.sysconf('SC_PAGE_SIZE')*os.sysconf('SC_PHYS_PAGES')/1048576)-2048))
   for tag in ['memory','currentMemory']:
    tag_el=x.find(tag)
    if tag_el is not None:
     tag_el.set('unit','MiB')
     tag_el.text=str(ram)
  if 'autostart' in r:
   d.setAutostart(1 if r['autostart'] else 0)
  if 'bootOrder' in r and isinstance(r['bootOrder'],list):
   os_el=x.find('os')
   if os_el is not None:
    for b in os_el.findall('boot'): os_el.remove(b)
    for dev in r['bootOrder']:
     E.SubElement(os_el,'boot',dev=dev)
  if 'iso' in r:
   cd=next((el for el in x.findall('./devices/disk') if el.get('device')=='cdrom'),None)
   if cd is not None:
    for src in cd.findall('source'): cd.remove(src)
    if r['iso']: E.SubElement(cd,'source',file=iso_path(r['iso']))
  if 'interfaces' in r or 'networkMode' in r:
   interfaces_req = r.get('interfaces')
   if not interfaces_req or not isinstance(interfaces_req, list):
    net_mode=r.get('networkMode','bridge')
    net_dev=r.get('networkDev','enp8s0f1')
    interfaces_req=[{'mode':net_mode,'dev':net_dev}]

   devs=x.find('devices')
   existing_macs=[]
   for el in devs.findall('interface'):
    mac_el=el.find('mac')
    if mac_el is not None and mac_el.get('address'):
     existing_macs.append(mac_el.get('address'))
    devs.remove(el)

   for idx, iface in enumerate(interfaces_req):
    m=iface.get('mode','bridge')
    dev_n=iface.get('dev') or 'enp8s0f1'
    if m=='nat':
     nic=E.SubElement(devs,'interface',type='network')
     E.SubElement(nic,'source',network='default')
     E.SubElement(nic,'model',type='virtio')
    elif m=='passthrough':
     nic=E.SubElement(devs,'interface',type='direct')
     E.SubElement(nic,'source',dev=dev_n,mode='passthrough')
     E.SubElement(nic,'model',type='virtio')
    else:
     nic=E.SubElement(devs,'interface',type='direct')
     E.SubElement(nic,'source',dev=dev_n,mode='bridge')
     E.SubElement(nic,'model',type='virtio')
    mac = iface.get('mac') or (existing_macs[idx] if idx < len(existing_macs) else None)
    if mac:
     E.SubElement(nic,'mac',address=mac)

   # Speed and duplex overrides for all direct interfaces
   nics=devs.findall('interface')
   x.set('xmlns:qemu', 'http://libvirt.org/schemas/domain/qemu/1.0')
   for el in x.findall('{http://libvirt.org/schemas/domain/qemu/1.0}override'): x.remove(el)
   qovr=E.SubElement(x, '{http://libvirt.org/schemas/domain/qemu/1.0}override')
   for idx, nic in enumerate(nics):
    src=nic.find('source')
    dev_name=src.get('dev') if src is not None else None
    if dev_name:
     cur_sp, cur_dup = detect_dev_speed_duplex(dev_name)
     qdev=E.SubElement(qovr, '{http://libvirt.org/schemas/domain/qemu/1.0}device', alias=f'net{idx}')
     qfe=E.SubElement(qdev, '{http://libvirt.org/schemas/domain/qemu/1.0}frontend')
     E.SubElement(qfe, '{http://libvirt.org/schemas/domain/qemu/1.0}property', name='speed', type='signed', value=str(cur_sp))
     E.SubElement(qfe, '{http://libvirt.org/schemas/domain/qemu/1.0}property', name='duplex', type='string', value=cur_dup)
  c.defineXML(E.tostring(x,encoding='unicode'))
  if d.isActive():
   if 'memory' in r:
    try: d.setMemoryFlags(ram*1024, libvirt.VIR_DOMAIN_AFFECT_LIVE)
    except Exception: pass
   if 'cpu' in r:
    try: d.setVcpusFlags(cpu, libvirt.VIR_DOMAIN_AFFECT_LIVE)
    except Exception: pass
  return describe(d)
 elif action=='force-stop':
  if r.get('confirmation')!=d.name():fail('请准确输入虚拟机名称确认强制关机')
  d.destroy()
 elif action=='delete':
  if r.get('confirmation')!=d.name():fail('请准确输入虚拟机名称确认删除')
  if d.isActive():
   try:
    d.destroy()
   except Exception as e:
    fail(f'强制关闭虚拟机电源失败: {e}')
  try:
   xml_desc = d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)
  except Exception:
   xml_desc = d.XMLDesc(0)
  x=E.fromstring(xml_desc);paths=[]
  for disk in x.findall('./devices/disk'):
   if disk.get('device')!='disk' or disk.get('type')!='file':continue
   src=disk.find('source');path=os.path.realpath(src.get('file','')) if src is not None else ''
   if path: paths.append(path)
  flags = libvirt.VIR_DOMAIN_UNDEFINE_MANAGED_SAVE | libvirt.VIR_DOMAIN_UNDEFINE_SNAPSHOTS_METADATA
  try:
   flags |= getattr(libvirt, 'VIR_DOMAIN_UNDEFINE_NVRAM', 0)
  except Exception:
   pass
  try:
   d.undefineFlags(flags)
  except Exception:
   d.undefine()
  deleted=[]
  for path in paths:
   if os.path.isfile(path):
    try:
     os.unlink(path)
     deleted.append(path)
    except Exception:
     pass
  return {'deleted':r.get('confirmation'),'deletedDisks':deleted}
 elif action=='autostart':
  if type(r.get('enabled'))!=bool:fail('无效自启参数')
  d.setAutostart(int(r['enabled']))
 elif action in ['configure','media','network-configure','eject-boot-disk']:
  if d.isActive():fail('请先关闭虚拟机再修改配置')
  x=E.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
  if action=='configure':
   cpu,ram=resources(r);x.find('vcpu').text=str(cpu)
   for tag in ['memory','currentMemory']:x.find(tag).set('unit','MiB');x.find(tag).text=str(ram)
  elif action=='network-configure':
   interfaces_req = r.get('interfaces')
   if not interfaces_req or not isinstance(interfaces_req, list):
    net_mode=r.get('networkMode','bridge')
    net_dev=r.get('networkDev','enp8s0f1')
    interfaces_req=[{'mode':net_mode,'dev':net_dev}]
   devs=x.find('devices')
   existing_macs=[]
   for el in devs.findall('interface'):
    mac_el=el.find('mac')
    if mac_el is not None and mac_el.get('address'):
     existing_macs.append(mac_el.get('address'))
    devs.remove(el)
   for idx, iface in enumerate(interfaces_req):
    m=iface.get('mode','bridge')
    dev_n=iface.get('dev') or 'enp8s0f1'
    if m=='nat':
     nic=E.SubElement(devs,'interface',type='network');E.SubElement(nic,'source',network='default');E.SubElement(nic,'model',type='virtio')
    elif m=='passthrough':
     nic=E.SubElement(devs,'interface',type='direct');E.SubElement(nic,'source',dev=dev_n,mode='passthrough');E.SubElement(nic,'model',type='virtio')
    else:
     nic=E.SubElement(devs,'interface',type='direct');E.SubElement(nic,'source',dev=dev_n,mode='bridge');E.SubElement(nic,'model',type='virtio')
    mac = iface.get('mac') or (existing_macs[idx] if idx < len(existing_macs) else None)
    if mac:
     E.SubElement(nic,'mac',address=mac)
  elif action=='eject-boot-disk':
   cd=next((el for el in x.findall('./devices/disk') if el.get('device')=='cdrom'),None)
   if cd is not None:
    for src in cd.findall('source'): cd.remove(src)
   os_el=x.find('os')
   if os_el is not None:
    for b in os_el.findall('boot'): os_el.remove(b)
    E.SubElement(os_el,'boot',dev='hd');E.SubElement(os_el,'boot',dev='cdrom')
  else:
   cd=next((el for el in x.findall('./devices/disk') if el.get('device')=='cdrom'),None)
   if cd is None:fail('此虚拟机没有光驱')
   for src in cd.findall('source'):cd.remove(src)
   if r.get('isoPath') and os.path.isfile(r['isoPath']): E.SubElement(cd,'source',file=r['isoPath'])
   elif r.get('iso'): E.SubElement(cd,'source',file=iso_path(r['iso']))
   if not r.get('iso') and not r.get('isoPath'):
    os_el=x.find('os')
    if os_el is not None:
     for b in os_el.findall('boot'): os_el.remove(b)
     E.SubElement(os_el,'boot',dev='hd');E.SubElement(os_el,'boot',dev='cdrom')
  c.defineXML(E.tostring(x,encoding='unicode'))
 elif action=='console':
  if not d.isActive():fail('虚拟机未运行')
  g=E.fromstring(d.XMLDesc()).find('./devices/graphics[@type="vnc"]')
  if g is None or g.get('listen')!='127.0.0.1':fail('此虚拟机未配置本机 VNC 控制台')
  return {'port':integer(int(g.get('port','-1')),5900,65535)}
 elif action=='screenshot':
  if not d.isActive():fail('虚拟机未运行')
  tmp=f"/tmp/vm_ss_{d.name()}.png"
  try:
   s=c.newStream(0)
   mimetype=d.screenshot(s,0,0)
   with open(tmp,'wb') as f:
    while True:
     buf=s.recv(262144)
     if not buf:break
     f.write(buf)
   s.finish()
   return {'path':tmp,'mimetype':mimetype}
  except Exception as e:
   fail(f'获取控制台截图失败: {e}')
 elif action=='backup-create':
  target_dir=ensure_backup_dir(r.get('targetDir'))
  sys_disk=get_system_disk(d)
  ts=datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
  safe_name=re.sub(r'[^A-Za-z0-9_.-]','_',d.name())
  filename=f"{safe_name}_{ts}.qcow2"
  dest=os.path.join(target_dir,filename)
  if d.isActive():
   x=E.fromstring(d.XMLDesc())
   bx=E.Element('domainbackup');disks_el=E.SubElement(bx,'disks')
   for disk in x.findall('./devices/disk'):
    dev_name=disk.find('target').get('dev') if disk.find('target') is not None else None
    if not dev_name: continue
    if dev_name==sys_disk['targetDev']:
     d_el=E.SubElement(disks_el,'disk',name=dev_name,type='file')
     E.SubElement(d_el,'target',file=dest)
     E.SubElement(d_el,'driver',type='qcow2')
    else:
     E.SubElement(disks_el,'disk',name=dev_name,backup='no')
   bxml=E.tostring(bx,encoding='unicode')
   try:
    d.backupBegin(bxml,None,0)
    while True:
     info=d.jobInfo()
     job_type=info[0]
     if job_type in [libvirt.VIR_DOMAIN_JOB_COMPLETED,libvirt.VIR_DOMAIN_JOB_NONE]: break
     if job_type in [libvirt.VIR_DOMAIN_JOB_FAILED,libvirt.VIR_DOMAIN_JOB_CANCELLED]: fail('在线备份任务失败或被取消')
     time.sleep(0.5)
   except Exception as e:
    if os.path.exists(dest): os.unlink(dest)
    fail(f'执行在线备份失败: {e}')
  else:
   try:
    subprocess.run(['qemu-img','convert','-O','qcow2',sys_disk['path'],dest],check=True)
   except Exception as e:
    if os.path.exists(dest): os.unlink(dest)
    fail(f'导出离线备份失败: {e}')
  try:
   shutil.chown(dest,user='libvirt-qemu',group='kvm')
   os.chmod(dest,0o660)
  except Exception: pass
  file_size=os.path.getsize(dest) if os.path.exists(dest) else 0
  meta={
   'id':f"{safe_name}_{ts}",
   'vmId':d.UUIDString(),
   'vmName':d.name(),
   'filename':filename,
   'filePath':dest,
   'targetDir':target_dir,
   'size':file_size,
   'createdAt':datetime.datetime.now().isoformat(),
   'type':r.get('backupType','manual'),
   'note':r.get('note','')
  }
  with open(dest+'.meta.json','w',encoding='utf-8') as mf:
   json.dump(meta,mf,ensure_ascii=False,indent=2)
  try: os.chmod(dest+'.meta.json',0o664)
  except Exception: pass
  return meta
 elif action=='backup-progress':
  if not d.isActive(): return {'active':False,'percent':0}
  try:
   info=d.jobInfo()
   job_type=info[0]
   if job_type==libvirt.VIR_DOMAIN_JOB_NONE:
    return {'active':False,'percent':0}
   file_total=info[9]
   file_processed=info[10]
   pct=round((file_processed/file_total)*100,1) if file_total>0 else 0
   return {'active':True,'jobType':job_type,'timeElapsedMs':info[1],'processedBytes':file_processed,'totalBytes':file_total,'percent':pct}
  except Exception as e:
   return {'active':False,'error':str(e)}
 elif action=='backup-restore':
  if d.isActive(): fail('请先关闭虚拟机再执行恢复')
  if r.get('confirmation')!=d.name(): fail('请输入虚拟机名称确认恢复操作')
  filename=r.get('filename','')
  target_dir=os.path.realpath(r.get('targetDir') or DEFAULT_BACKUP_DIR)
  if not filename or '/' in filename or '\\' in filename: fail('无效备份文件名')
  backup_file=os.path.join(target_dir,filename)
  if not os.path.isfile(backup_file): fail('备份文件不存在: '+filename)
  sys_disk=get_system_disk(d,inactive=True)
  target_path=sys_disk['path']
  safety_bak=target_path+'.before-restore'
  try:
   if os.path.exists(safety_bak): os.unlink(safety_bak)
   shutil.copy2(target_path,safety_bak)
  except Exception: pass
  try:
   subprocess.run(['qemu-img','convert','-O','qcow2',backup_file,target_path],check=True)
   shutil.chown(target_path,user='libvirt-qemu',group='kvm')
   os.chmod(target_path,0o660)
  except Exception as e:
   if os.path.exists(safety_bak): shutil.move(safety_bak,target_path)
   fail(f'恢复镜像写入失败: {e}')
  if os.path.exists(safety_bak):
   try: os.unlink(safety_bak)
   except Exception: pass
  return {'restored':d.name(),'backupFile':filename}
 else:fail('不支持的操作')
 return describe(d)

try: print(json.dumps({'success':True,'data':main(json.load(sys.stdin))}))
except Exception as e: print(json.dumps({'success':False,'error':str(e)}));sys.exit(1)
