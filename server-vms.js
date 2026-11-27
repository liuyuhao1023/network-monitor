'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),net=require('net'),zlib=require('zlib');
const {spawn,spawnSync,exec}=require('child_process');const {pipeline}=require('stream/promises');const {Transform}=require('stream');

module.exports=function registerVMs(app,activeSessions){
 const configFile=path.join(__dirname,'vm-backup-config.json');

 function getBackupConfig(){
  try{
   if(fs.existsSync(configFile)) return JSON.parse(fs.readFileSync(configFile,'utf-8'));
  }catch(e){console.error('Failed reading vm-backup-config.json:',e);}
  return {enabled:true,time:'05:00',retentionDays:7,targetDir:'/mnt/raid10/vm-backups',targetVm:'all'};
 }

 function saveBackupConfig(cfg){
  try{
   fs.writeFileSync(configFile,JSON.stringify(cfg,null,2),{mode:0o600});
  }catch(e){console.error('Failed writing vm-backup-config.json:',e);}
 }

 if(!fs.existsSync(configFile)){
  saveBackupConfig({enabled:true,time:'05:00',retentionDays:7,targetDir:'/mnt/raid10/vm-backups',targetVm:'all'});
 }

 const tickets=new Map();let queue=Promise.resolve(),cached=null,pending=null;
 const actionNames={
  'create':'创建虚拟机','start':'打开电源','shutdown':'正常关机','reboot':'重新引导客户机',
  'reset':'强制重置','pause':'挂起虚拟机','resume':'恢复虚拟机','force-stop':'关闭电源 (强制断电)',
  'delete':'删除虚拟机','clone':'克隆虚拟机','edit-settings':'编辑硬件配置',
  'backup-create':'热备系统盘镜像','backup-restore':'恢复系统盘镜像','backup-delete':'删除备份镜像',
  'media':'挂载光驱镜像','eject-boot-disk':'弹出镜像设为硬盘启动','network-configure':'修改网卡模式',
  'backup-schedule-update':'更新自动备份策略',
  'ct-template-download':'下载 CT 镜像模板',
  'ct-template-delete':'删除 CT 镜像模板',
  'ct-create':'创建 CT 容器',
  'ct-start':'启动 CT 容器',
  'ct-stop':'停止 CT 容器',
  'ct-kill':'强制停止 CT 容器',
  'ct-restart':'重启 CT 容器',
  'ct-destroy':'销毁 CT 容器',
 };
 const recentTasks=[];
 function initRecentTasks(){
  try{
   const auditFile=path.join(__dirname,'vm-audit.jsonl');
   if(!fs.existsSync(auditFile)) return;
   const lines=fs.readFileSync(auditFile,'utf-8').trim().split('\n').filter(Boolean);
   for(let i=lines.length-1; i>=0 && recentTasks.length<20; i--){
    try{
     const j=JSON.parse(lines[i]);
     if(!actionNames[j.action]) continue;
     const dt=new Date(j.time);
     const timeStr=isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString('zh-CN',{hour12:false});
     recentTasks.push({
      id:'t-'+dt.getTime().toString(36)+'-'+recentTasks.length,
      name:actionNames[j.action]||j.action,
      target:j.name||j.id||'虚拟机',
      status:j.success ? '已完成' : ('失败: '+(j.error||'异常')),
      user:j.user||'Administrator',
      startTime:timeStr,
      duration:j.duration||'—'
     });
    }catch(e){}
   }
  }catch(e){console.error('Failed initRecentTasks:',e);}
 }
 initRecentTasks();

 function recordTask(action, targetName, user, status='已完成', duration='< 1s'){
  if(!actionNames[action]) return;
  recentTasks.unshift({
   id:'t-'+Date.now().toString(36),
   name:actionNames[action]||action,
   target:targetName||'虚拟机',
   status:status,
   user:user||'Administrator',
   startTime:new Date().toLocaleTimeString('zh-CN',{hour12:false}),
   duration:duration
  });
  if(recentTasks.length>50) recentTasks.pop();
 }
  function runCt(args, stdinData){
  return new Promise((resolve,reject)=>{
   const helperPath=path.join(__dirname,"ct-helper.py");
   const p=spawn("/usr/bin/python3",[helperPath,...args],{stdio:["pipe","pipe","pipe"]});
   let out="",err="";
   const t=setTimeout(()=>p.kill(),120000);
   p.stdout.on("data",d=>out+=d);
   p.stderr.on("data",d=>err+=d);
   p.on("error",e=>{clearTimeout(t);reject(e);});
   p.on("close",code=>{
    clearTimeout(t);
    try{
     const j=JSON.parse(out||"{}");
     resolve(j);
    }catch(e){
     resolve({success:false,error:err||out||e.message});
    }
   });
   if(stdinData){
    p.stdin.write(typeof stdinData==="string"?stdinData:JSON.stringify(stdinData));
    p.stdin.end();
   }
  });
 }
 function run(data){
  return new Promise((resolve,reject)=>{
   const p=spawn('/usr/bin/python3',[path.join(__dirname,'vm-helper.py')],{stdio:['pipe','pipe','pipe']});
   let out='',err='';
   const timeoutMs=(data.action&&data.action.startsWith('backup-'))?600000:60000;
   const t=setTimeout(()=>p.kill(),timeoutMs);
   p.stdout.on('data',d=>out+=d);
   p.stderr.on('data',d=>err+=d);
   p.on('error',reject);
   p.on('close',()=>{
    clearTimeout(t);
    try{
     const j=JSON.parse(out);
     if(!j.success)throw Error(j.error);
     resolve(j.data);
    }catch(e){
     reject(Error(e.message||err||'Python process failed'));
    }
   });
   p.stdin.end(JSON.stringify(data));
  });
 }

 function admin(req,res,next){
  if(req.sessionUser?.role!=='Administrator')return res.status(403).json({success:false,error:'仅管理员可管理虚拟机'});
  next();
 }

 const audit=record=>{
  try{
   fs.appendFileSync(path.join(__dirname,'vm-audit.jsonl'),JSON.stringify({time:new Date().toISOString(),...record})+'\n',{mode:0o600});
  }catch(e){console.error(e);}
 };

 app.get('/api/vms/tasks',(req,res)=>{
   res.json({success:true,data:recentTasks});
  });

   app.get("/api/vms/cts",async(req,res)=>{
  try{
   const data=await runCt(["list"]);
   res.json({success:true,data});
  }catch(e){
   res.status(500).json({success:false,error:e.message});
  }
 });

 app.get("/api/vms/cts/host-interfaces",async(req,res)=>{
  try{
   const data=await runCt(["host-interfaces"]);
   res.json({success:true,data});
  }catch(e){
   res.status(500).json({success:false,error:e.message});
  }
 });

 app.get("/api/vms/cts/template-sources",async(req,res)=>{
  try{
   const data=await runCt(["sources"]);
   res.json({success:true,data});
  }catch(e){
   res.status(500).json({success:false,error:e.message});
  }
 });

 app.get("/api/vms/cts/local-templates",async(req,res)=>{
  try{
   const data=await runCt(["local_templates"]);
   res.json({success:true,data});
  }catch(e){
   res.status(500).json({success:false,error:e.message});
  }
 });

  // ─── CT Template Download Engine with Live Recent Tasks Tracking ───
  let activeCtDownload = null;
  const MIRROR_BASE = {
    ustc: 'https://mirrors.ustc.edu.cn/proxmox/images/system/',
    tsinghua: 'https://mirrors.tuna.tsinghua.edu.cn/proxmox/images/system/',
    official: 'http://download.proxmox.com/images/system/'
  };

  function startTemplateDownload({ filename, targetDir, mirror, user }) {
    if (activeCtDownload && activeCtDownload.active) {
      throw new Error(`当前已有正在进行的下载任务: ${activeCtDownload.filename} (${activeCtDownload.progress}%)，请等待完成`);
    }

    const base = MIRROR_BASE[mirror] || MIRROR_BASE.ustc;
    const url = base.replace(/\/+$/, '') + '/' + filename;
    const dir = targetDir || '/mnt/raid10/template/cache';

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
    } catch (err) {
      throw new Error(`创建存储目录 ${dir} 失败: ${err.message}`);
    }

    const destPath = path.join(dir, filename);
    const partPath = destPath + '.part';

    if (fs.existsSync(destPath)) {
      const sz = (fs.statSync(destPath).size / 1048576).toFixed(1);
      throw new Error(`模板 ${filename} (${sz} MB) 在此存储目录下已存在，无需重复下载！`);
    }

    const taskId = 't-ct-dl-' + Date.now().toString(36);
    const dsName = path.basename(dir);
    const taskObj = {
      id: taskId,
      name: '下载 CT 镜像模板',
      target: `${filename} (${dsName})`,
      user: user || 'Administrator',
      status: '正在连接镜像源 (0%)',
      progress: 0,
      startTime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      duration: '0s'
    };

    recentTasks.unshift(taskObj);
    if (recentTasks.length > 50) recentTasks.pop();

    activeCtDownload = {
      taskId,
      filename,
      targetDir: dir,
      active: true,
      progress: 0,
      downloadedMB: '0.0',
      totalMB: '0.0',
      speed: '0 KB/s',
      status: '正在连接中科大镜像源...'
    };

    const startTime = Date.now();
    let lastStatTime = startTime;
    let lastBytes = 0;
    let totalBytes = 0;

    // 1. Fetch Content-Length via curl -sI
    exec(`curl -sI -L -k "${url}"`, { timeout: 10000 }, (headErr, headOut) => {
      if (!headErr && headOut) {
        const match = headOut.match(/content-length:\s*(\d+)/i);
        if (match) {
          totalBytes = parseInt(match[1], 10);
          activeCtDownload.totalMB = (totalBytes / 1048576).toFixed(1);
        }
      }

      // 2. Start curl download to partPath
      const curlProc = spawn('/usr/bin/curl', [
        '-f', '-L', '-k',
        '--connect-timeout', '15',
        '-o', partPath,
        url
      ]);

      const progressInterval = setInterval(() => {
        try {
          if (!fs.existsSync(partPath)) return;
          const st = fs.statSync(partPath);
          const currentBytes = st.size;
          const now = Date.now();
          const deltaSec = (now - lastStatTime) / 1000;

          let speedStr = '—';
          if (deltaSec >= 0.5) {
            const speedBps = (currentBytes - lastBytes) / deltaSec;
            lastBytes = currentBytes;
            lastStatTime = now;
            speedStr = speedBps >= 1048576 
              ? (speedBps / 1048576).toFixed(1) + ' MB/s' 
              : (speedBps / 1024).toFixed(0) + ' KB/s';
            activeCtDownload.speed = speedStr;
          }

          const downloadedMB = (currentBytes / 1048576).toFixed(1);
          activeCtDownload.downloadedMB = downloadedMB;

          let pct = 0;
          if (totalBytes > 0) {
            pct = Math.min(99, Math.round((currentBytes / totalBytes) * 100));
          } else {
            pct = Math.min(95, Math.round((currentBytes / (currentBytes + 5000000)) * 100));
          }
          activeCtDownload.progress = pct;

          const elapsedSec = Math.round((now - startTime) / 1000);
          taskObj.progress = pct;
          taskObj.status = `正在拉取 (${pct}% · ${downloadedMB}MB${totalBytes ? '/' + activeCtDownload.totalMB + 'MB' : ''} · ${activeCtDownload.speed})`;
          taskObj.duration = `${elapsedSec}s`;
          activeCtDownload.status = taskObj.status;
        } catch (_) {}
      }, 600);

      curlProc.on('close', (code) => {
        clearInterval(progressInterval);
        const totalSec = Math.round((Date.now() - startTime) / 1000);
        taskObj.duration = `${totalSec}s`;

        if (code === 0 && fs.existsSync(partPath)) {
          try {
            fs.renameSync(partPath, destPath);
            const finalMB = (fs.statSync(destPath).size / 1048576).toFixed(1);
            taskObj.progress = 100;
            taskObj.status = '已完成';
            activeCtDownload = {
              active: false,
              success: true,
              filename,
              destPath,
              message: `CT 模板 ${filename} (${finalMB} MB) 下载完成！`
            };
          } catch (renameErr) {
            taskObj.status = '失败: 重命名失败';
            activeCtDownload = { active: false, error: renameErr.message, filename };
          }
        } else {
          if (fs.existsSync(partPath)) {
            try { fs.unlinkSync(partPath); } catch (_) {}
          }
          taskObj.status = `失败 (code ${code})`;
          activeCtDownload = { active: false, error: `下载中断或网络异常 (code ${code})`, filename };
        }
      });

      curlProc.on('error', (procErr) => {
        clearInterval(progressInterval);
        if (fs.existsSync(partPath)) {
          try { fs.unlinkSync(partPath); } catch (_) {}
        }
        taskObj.status = `失败: ${procErr.message}`;
        activeCtDownload = { active: false, error: procErr.message, filename };
      });
    });

    return { success: true, message: `已开始从中科大源极速拉取模板 ${filename}` };
  }

  app.get("/api/vms/cts/download-progress", (req, res) => {
    res.json({ success: true, data: activeCtDownload || { active: false } });
  });

  app.post("/api/vms/cts/download-template", admin, (req, res) => {
    try {
      const payload = req.body || {};
      const result = startTemplateDownload({
        filename: payload.filename,
        targetDir: payload.targetDir,
        mirror: payload.mirror,
        user: req.sessionUser?.username || 'Administrator'
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  app.post("/api/vms/cts/delete-template", admin, (req, res) => {
    try {
      const { path: tmplPath } = req.body || {};
      if (!tmplPath || !fs.existsSync(tmplPath)) {
        return res.status(400).json({ success: false, error: "模板文件不存在" });
      }
      fs.unlinkSync(tmplPath);
      recentTasks.unshift({
        id: 't-ct-del-' + Date.now().toString(36),
        name: '删除 CT 镜像模板',
        target: path.basename(tmplPath),
        status: '已完成',
        user: req.sessionUser?.username || 'Administrator',
        startTime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        duration: '< 1s'
      });
      if (recentTasks.length > 50) recentTasks.pop();
      res.json({ success: true, message: "模板已成功删除" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

 app.get("/api/vms/cts/templates",async(req,res)=>{
  try{
   const data=await runCt(["templates"]);
   res.json({success:true,data});
  }catch(e){
   res.status(500).json({success:false,error:e.message});
  }
 });

 app.post("/api/vms/cts/action",admin,async(req,res)=>{
  try{
   const {id,action}=req.body||{};
   if(!id||!action) return res.status(400).json({success:false,error:"缺少容器 ID 或操作类型"});
   const data=await runCt(["action",String(id),String(action)]);
   recentTasks.unshift({
    id:"t-"+Date.now().toString(36),
    name:`CT ${action}`,
    target:id,
    status:data.success?"已完成":"失败",
    user:req.sessionUser?.username||"Administrator",
    startTime:new Date().toLocaleTimeString("zh-CN",{hour12:false})
   });
   if(recentTasks.length>50) recentTasks.pop();
   res.json(data);
  }catch(e){
   res.status(500).json({success:false,error:e.message});
  }
 });

 app.post("/api/vms/cts/create",admin,async(req,res)=>{
  try{
   const payload=req.body||{};
   const data=await runCt(["create"],payload);
   recentTasks.unshift({
    id:"t-"+Date.now().toString(36),
    name:"创建 CT 容器",
    target:payload.name||payload.vmid||"新容器",
    status:data.success?"已完成":"失败",
    user:req.sessionUser?.username||"Administrator",
    startTime:new Date().toLocaleTimeString("zh-CN",{hour12:false})
   });
   if(recentTasks.length>50) recentTasks.pop();
   res.json(data);
  }catch(e){
   res.status(500).json({success:false,error:e.message});
  }
 });

  app.post("/api/vms/cts/exec",admin,async(req,res)=>{
   try{
    const {name,command}=req.body||{};
    if(!name) return res.status(400).json({success:false,error:"缺少容器名称"});
    const data=await runCt(["exec"],{name:String(name),command:String(command||"uptime")});
    res.json(data);
   }catch(e){
    res.status(500).json({success:false,error:e.message});
   }
  });

  app.post("/api/vms/cts/edit-settings",admin,async(req,res)=>{
   try{
    const payload = req.body || {};
    if(!payload.name) return res.status(400).json({success:false, error:"缺少容器名称"});
    const data = await runCt(["edit-settings"], payload);
    recentTasks.unshift({
     id:"t-"+Date.now().toString(36),
     name:"修改 CT 容器配置",
     target:payload.name,
     status:data.success?"已完成":"失败",
     user:req.sessionUser?.username||"Administrator",
     startTime:new Date().toLocaleTimeString("zh-CN",{hour12:false})
    });
    if(recentTasks.length>50) recentTasks.pop();
    res.json(data);
   }catch(e){
    res.status(500).json({success:false,error:e.message});
   }
  });

 app.get('/api/vms',async(req,res)=>{
  try{
   if(!cached||Date.now()-cached.time>3000){
    if(!pending)pending=run({action:'list'}).then(data=>cached={time:Date.now(),data}).finally(()=>pending=null);
    await pending;
   }
   res.json({success:true,data:cached.data});
  }catch(e){res.status(503).json({success:false,error:e.message});}
 });

 app.get('/api/vms/backups',async(req,res)=>{
  try{
   const cfg=getBackupConfig();
   const targetDir=req.query.targetDir||cfg.targetDir||'/mnt/raid10/vm-backups';
   const [backupData,targets]=await Promise.all([
    run({action:'backup-list',targetDir,vmId:req.query.vmId||''}),
    run({action:'datastores'})
   ]);
   res.json({success:true,data:{...backupData,storageTargets:targets,schedule:cfg}});
  }catch(e){res.status(500).json({success:false,error:e.message});}
 });

 app.post('/api/vms/backup-schedule',admin,async(req,res)=>{
  try{
   const b=req.body||{};
   const oldCfg=getBackupConfig();
   const cfg={
    enabled:Boolean(b.enabled),
    time:String(b.time||'05:00').match(/^\d{1,2}:\d{2}$/)?b.time:'05:00',
    retentionDays:Math.max(1,Math.min(365,Number(b.retentionDays)||7)),
    targetDir:String(b.targetDir||'/mnt/raid10/vm-backups').trim(),
    targetVm:String(b.targetVm||'all').trim(),
    lastRunDate:oldCfg.lastRunDate||''
   };
   saveBackupConfig(cfg);
   audit({user:req.sessionUser.username,action:'backup-schedule-update',schedule:cfg,success:true});
   recordTask('backup-schedule-update', '自动备份策略', req.sessionUser.username, '已完成', '< 1s');
   res.json({success:true,data:cfg});
  }catch(e){res.status(400).json({success:false,error:e.message});}
 });

 app.get('/api/vms/backup-progress',async(req,res)=>{
  try{
   const id=req.query.id||'FeiNiuOS';
   const data=await run({action:'backup-progress',id});
   res.json({success:true,data});
  }catch(e){
   res.json({success:true,data:{active:false,percent:0}});
  }
 });

 app.post('/api/vms/action',admin,async(req,res)=>{
  const input=req.body||{};
  const allowed=[
   'create','start','shutdown','reboot','reset','pause','resume','force-stop','autostart','configure','media',
   'console','iso-delete','delete','backup-create','backup-restore','backup-delete','backup-progress',
   'backup-list','storage-targets','network-configure','network-interfaces',
   'eject-boot-disk','datastores','datastore-browse','clone','edit-settings','stats','screenshot'
  ];
  if(!allowed.includes(input.action))return res.status(400).json({success:false,error:'无效操作'});
  const startTime=Date.now();
  const task=queue.then(()=>run(input));queue=task.catch(()=>{});
  try{
   const targetVmName = input.name || input.newName || (cached?.data?.vms?.find(v=>v.id===input.id)?.name) || input.id || '虚拟机';
   const data=await task;cached=null;
   const duration=((Date.now()-startTime)/1000).toFixed(1)+'s';
   audit({user:req.sessionUser.username,action:input.action,id:input.id,name:targetVmName,duration,success:true});
   recordTask(input.action, targetVmName, req.sessionUser.username, '已完成', duration);
   if(input.action==='console'){
    const token=crypto.randomBytes(32).toString('hex');
    tickets.set(token,{port:data.port,user:req.sessionUser,expires:Date.now()+60000});
    return res.json({success:true,data:{token}});
   }
   res.json({success:true,data});
  }catch(e){
   const duration=((Date.now()-startTime)/1000).toFixed(1)+'s';
   const targetVmName = input.name || input.id || '虚拟机';
   audit({user:req.sessionUser.username,action:input.action,id:input.id,name:targetVmName,duration,success:false,error:e.message});
   recordTask(input.action, targetVmName, req.sessionUser.username, '失败: ' + e.message, duration);
   res.status(400).json({success:false,error:e.message});
  }
 });

 // Scheduled Backup Worker
 let lastBackupRunDate='';
 async function checkScheduledBackups(){
  const cfg=getBackupConfig();
  if(!cfg.enabled) return;
  const now=new Date();
  const pad=n=>String(n).padStart(2,'0');
  const currentDate=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const currentTime=`${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const [schedH, schedM]=String(cfg.time||'04:00').split(':').map(Number);
  const nowMinutes=now.getHours()*60+now.getMinutes();
  const schedMinutes=schedH*60+schedM;

  if(nowMinutes >= schedMinutes && cfg.lastRunDate !== currentDate && lastBackupRunDate !== currentDate){
   lastBackupRunDate=currentDate;
   cfg.lastRunDate=currentDate;
   saveBackupConfig(cfg);
   console.log(`[BackupScheduler] Triggering daily VM backups (Scheduled: ${cfg.time}, Current: ${currentTime})...`);
   try{
    const vmsData=await run({action:'list'});
    const vms=vmsData.vms||[];
    const targetVMs=(cfg.targetVm && cfg.targetVm!=='all')?vms.filter(v=>v.id===cfg.targetVm||v.name===cfg.targetVm):vms;

    for(const vm of targetVMs){
     try{
      console.log(`[BackupScheduler] Backing up system disk for VM ${vm.name} (${vm.id})...`);
      await run({action:'backup-create',id:vm.id,targetDir:cfg.targetDir,backupType:'scheduled',note:`Daily ${cfg.time} scheduled backup`});
      audit({user:'system-scheduler',action:'backup-create',id:vm.id,name:vm.name,success:true});
     }catch(err){
      console.error(`[BackupScheduler] Failed backing up VM ${vm.name}:`,err.message);
      audit({user:'system-scheduler',action:'backup-create',id:vm.id,name:vm.name,success:false,error:err.message});
     }
    }

    try{
     const listData=await run({action:'backup-list',targetDir:cfg.targetDir});
     const retentionMs=(cfg.retentionDays||7)*86400*1000;
     const cutoff=Date.now()-retentionMs;
     for(const b of (listData.backups||[])){
      const createdTime=new Date(b.createdAt).getTime();
      if(!isNaN(createdTime) && createdTime < cutoff){
       console.log(`[BackupScheduler] Pruning expired backup ${b.filename} (created ${b.createdAt})...`);
       await run({action:'backup-delete',filename:b.filename,targetDir:cfg.targetDir});
       audit({user:'system-scheduler',action:'backup-delete',filename:b.filename,reason:'retention-expired',success:true});
      }
     }
    }catch(err){
     console.error('[BackupScheduler] Retention cleanup error:',err.message);
    }
   }catch(err){
    console.error('[BackupScheduler] Scheduler run error:',err.message);
   }
  }
 }
 const schedulerTimer=setInterval(checkScheduledBackups,30000);
 schedulerTimer.unref();

 let uploading=false;
 app.post('/api/vms/iso',admin,async(req,res)=>{
  const name=String(req.query.name||'').trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,149}\.(iso|img|qcow2|vmdk|raw|gz)$/i.test(name)){
    return res.status(400).json({success:false,error:'镜像/固件文件名仅支持英文、数字、点、短横线和下划线，支持扩展名: .iso, .img, .img.gz, .gz, .qcow2, .vmdk'});
  }
  const size=Number(req.headers['content-length']);
  if(!Number.isSafeInteger(size)||size<1024||size>100*1024**3){
    return res.status(400).json({success:false,error:'上传文件大小须在 1 KiB–100 GiB 之间'});
  }
  if(uploading)return res.status(409).json({success:false,error:'已有镜像正在上传中，请稍候'});

  // Resolve target directory from datastoreId or targetDir
  let targetIsoDir='/mnt/raid10/iso';
  const dsId=req.query.datastoreId;
  if(dsId==='datastore1') targetIsoDir='/var/lib/libvirt/images/network-monitor/iso';
  else if(dsId==='datastore-ssd') targetIsoDir='/mnt/vadata/iso';
  else if(dsId==='datastore-raid10') targetIsoDir='/mnt/raid10/iso';
  else if(req.query.targetDir && fs.existsSync(req.query.targetDir)) targetIsoDir=req.query.targetDir;
  fs.mkdirSync(targetIsoDir,{recursive:true});

  // Handle .gz decompression on the fly (e.g. iStoreOS .img.gz)
  const isGz=name.toLowerCase().endsWith('.gz');
  let finalName=name;
  if(isGz){
    let base=name.slice(0,-3);
    if(!/\.(img|raw|iso|qcow2|vmdk)$/i.test(base)) base += '.img';
    finalName=base;
  }

  const dest=path.join(targetIsoDir,finalName),tmp=dest+'.'+crypto.randomBytes(8).toString('hex')+'.upload';
  if(fs.existsSync(dest))return res.status(409).json({success:false,error:'同名文件【' + finalName + '】已存在于该数据存储中'});
  const stat=fs.statfsSync(targetIsoDir);
  if(size>stat.bavail*stat.bsize-5*1024**3)return res.status(400).json({success:false,error:'目标数据存储可用空间不足'});

  uploading=true;let total=0;
  try{
    if(isGz){
      await pipeline(
        req,
        new Transform({transform(chunk,enc,cb){total+=chunk.length;cb(null,chunk);}}),
        zlib.createGunzip(),
        fs.createWriteStream(tmp,{flags:'wx',mode:0o644})
      );
    } else {
      await pipeline(
        req,
        new Transform({transform(chunk,enc,cb){total+=chunk.length;cb(total>size?Error('上传大小超出声明大小'):null,chunk);}}),
        fs.createWriteStream(tmp,{flags:'wx',mode:0o644})
      );
      if(total!==size)throw Error('上传不完整');
    }

    // Format verification
    if(finalName.toLowerCase().endsWith('.iso')){
      const fd=fs.openSync(tmp,'r'),buf=Buffer.alloc(5);
      try{fs.readSync(fd,buf,0,5,32769);}finally{fs.closeSync(fd);}
      if(buf.toString()!=='CD001'){
        const check=spawnSync('qemu-img',['info','--force-share',tmp],{timeout:10000});
        if(check.status!==0)throw Error('不是有效的 ISO 安装光盘镜像');
      }
    } else {
      const check=spawnSync('qemu-img',['info','--force-share',tmp],{timeout:15000});
      if(check.status!==0){
        throw Error('镜像文件格式损坏或不受 QEMU 支持: '+(check.stderr?.toString()||'无法解析'));
      }
    }

    fs.linkSync(tmp,dest);
    fs.unlinkSync(tmp);
    try{fs.chmodSync(dest,0o664);}catch(_){}
    cached=null;

    const finalStat=fs.statSync(dest);
    audit({
      user:req.sessionUser.username,
      action:isGz?'firmware-unzip-upload':(finalName.endsWith('.iso')?'iso-upload':'firmware-upload'),
      name:finalName,
      originalName:name,
      size:finalStat.size,
      targetIsoDir,
      success:true
    });
    res.json({
      success:true,
      data:{
        name:finalName,
        originalName:name,
        path:dest,
        targetDir:targetIsoDir,
        size:finalStat.size,
        decompressed:isGz
      }
    });
  }catch(e){
    try{fs.unlinkSync(tmp);}catch(_){}
    if(!res.headersSent)res.status(400).json({success:false,error:e.message});
  }finally{uploading=false;}
 });

 app.use('/vm-console-assets',require('express').static('/usr/share/novnc'));
 
 app.get('/api/vms/screenshot',admin,async(req,res)=>{
  const id=req.query.id;
  if(!id)return res.status(400).send('Missing id');
  try{
   const data=await run({action:'screenshot',id});
   if(data&&data.path&&fs.existsSync(data.path)){
    res.setHeader('Content-Type',data.mimetype||'image/png');
    res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
    fs.createReadStream(data.path).pipe(res);
   }else{
    res.status(404).send('No screenshot');
   }
  }catch(e){
   res.status(500).send(e.message);
  }
 });

 const timer=setInterval(()=>{for(const [k,v] of tickets)if(v.expires<Date.now())tickets.delete(k);},30000);timer.unref();

 return function attach(server){
  const {WebSocketServer}=require('ws');const wss=new WebSocketServer({noServer:true,maxPayload:4*1024*1024});
  server.on('upgrade',(req,socket,head)=>{
   let u;
   try{u=new URL(req.url,'http://localhost');}catch(_){return;}
   if(u.pathname!=='/vm-console-socket')return;
   const ticketId=u.searchParams.get('ticket');
   const ticket=tickets.get(ticketId);
   if(!ticket){
    console.warn('[VM Console WS] No ticket found for:',ticketId);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
   }
   if(ticket.expires<Date.now()){
    tickets.delete(ticketId);
    console.warn('[VM Console WS] Ticket expired');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
   }
   tickets.delete(ticketId);
   wss.handleUpgrade(req,socket,head,ws=>{
    console.log(`[VM Console WS] Connected to VNC port ${ticket.port} for user ${ticket.user?.username}`);
    const tcp=net.connect(ticket.port,'127.0.0.1');
    tcp.on('data',d=>{if(ws.readyState===1)ws.send(d,{binary:true});});
    ws.on('message',d=>{if(tcp.writable)tcp.write(d);});
    tcp.on('error',err=>{console.warn('[VM Console TCP Err]',err.message);ws.close();});
    tcp.on('close',()=>ws.close());
    ws.on('close',()=>tcp.destroy());
    ws.on('error',err=>{console.warn('[VM Console WS Err]',err.message);tcp.destroy();});
   });
  });
 };
};
