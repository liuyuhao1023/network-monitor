'use strict';
const fs = require('fs');
const path = require('path');
const runDefault = require('util').promisify(require('child_process').execFile);
const pairs = text => Object.fromEntries(text.split('\n').filter(l => l.includes(':')).map(l => { const i = l.indexOf(':'); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; }));
module.exports = function registerPower(app, options = {}) {
    const run = options.run || runDefault;
    const audit = options.audit || (record => fs.appendFileSync(path.join(__dirname, 'power-audit.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 }));
    let cache = null, pending = null, serial = Promise.resolve();
    const command = (file,args) => {
        const p = serial.then(() => run(file,args,{timeout:15000,maxBuffer:1024*1024,env:{...process.env,LC_ALL:'C'}}));
        serial = p.catch(() => {});
        return p;
    };
    const ipmi = args => command('/usr/bin/ipmitool',['-I','open',...args]);
    const fanSlots = {FRNT_FAN1:4,FRNT_FAN2:5,FRNT_FAN3:6,FRNT_FAN4:7};
    const fanConfigFile=options.fanConfigFile || path.join(__dirname,'board-fan-settings.json');
    function readFanConfig() {
        if(!fs.existsSync(fanConfigFile)) return {fans:{},policies:{}};
        const data=JSON.parse(fs.readFileSync(fanConfigFile,'utf8'));
        if(data.version!==1 || !data.fans || typeof data.fans!=='object')throw new Error('风扇保存配置格式错误');
        for(const [name,value] of Object.entries(data.fans)) if(!Object.hasOwn(fanSlots,name)||!Number.isInteger(value)||(value!==0&&(value<30||value>100)))throw new Error('风扇保存配置包含无效参数');
        const policies=data.policies&&typeof data.policies==='object'?data.policies:{};
        if(policies.FRNT_FAN3!==undefined&&policies.FRNT_FAN3!=='disk-temp')throw new Error('硬盘风扇策略无效');
        return {fans:data.fans,policies};
    }
    const readFanSettings=()=>readFanConfig().fans;
    function saveFanSettings(fans,policies=readFanConfig().policies) {
        const temp=fanConfigFile+'.tmp';
        const fd=fs.openSync(temp,'w',0o600);
        try {fs.writeFileSync(fd,JSON.stringify({version:1,fans,policies},null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        fs.renameSync(temp,fanConfigFile);
    }
    let fanRestoreStatus='未保存开机配置';
    let fanQueue = Promise.resolve();
    async function fanRegisters() {
        const raw=(await ipmi(['raw','0x3a','0x02'])).stdout.trim().split(/\s+/);
        if(raw.length!==8 || raw.some(v=>! /^[0-9a-f]{2}$/i.test(v))) throw new Error('风扇寄存器格式不匹配');
        return raw.map(v=>parseInt(v,16));
    }
    const writeFans = values => ipmi(['raw','0x3a','0x01',...values.map(v=>'0x'+v.toString(16).padStart(2,'0'))]);
    app.post('/api/board-fans/control', async(req,res)=>{
        if(req.sessionUser?.role!=='Administrator') return res.status(403).json({success:false,error:'仅管理员可调速'});
        const {fan,mode,percent}=req.body||{};
        if(!Object.hasOwn(fanSlots,fan)||!['auto','manual','disk-temp'].includes(mode)||(mode==='disk-temp'&&fan!=='FRNT_FAN3')||(mode==='manual'&&(!Number.isInteger(percent)||percent<30||percent>100))) return res.status(400).json({success:false,error:'请选择 FAN1–4；手动占空比必须是 30–100 的整数；硬盘温控仅支持 FAN3'});
        const task=fanQueue.then(async()=>{
            const model=(options.boardModel || fs.readFileSync('/sys/class/dmi/id/board_name','utf8')).trim();
            if(model!=='D1540D4U-2T8R') throw new Error('当前主板型号不匹配，禁止写入');
            const before=await fanRegisters(),next=[...before];
            const cfg=readFanConfig(),saved=cfg.fans,policies={...cfg.policies};
            if(mode==='disk-temp')policies.FRNT_FAN3='disk-temp';
            else if(fan==='FRNT_FAN3')delete policies.FRNT_FAN3;
            next[fanSlots[fan]]=mode==='auto'?0:mode==='disk-temp'?(before[fanSlots[fan]]||100):percent;
            try {
                await writeFans(next);
                const after=await fanRegisters();
                if(after.some((v,i)=>v!==next[i])) throw new Error('控制参数读回不一致');
                saveFanSettings({...saved,[fan]:next[fanSlots[fan]]},policies);
                fanRestoreStatus='已保存，服务启动时自动恢复';
                cache=null;
                try {audit({time:new Date().toISOString(),user:req.sessionUser.username,action:'board-fan',fan,mode,percent:next[fanSlots[fan]],before,after,success:true,persisted:true});}catch(e){console.error('Fan audit:',e.message);}
                if(mode==='disk-temp')setTimeout(()=>runDiskFanCycle(),0);
                return {fan,mode,percent:next[fanSlots[fan]]};
            } catch(e) {
                let restored=false;
                try {await writeFans(before);restored=(await fanRegisters()).every((v,i)=>v===before[i]);} catch(_) {}
                cache=null;
                audit({time:new Date().toISOString(),user:req.sessionUser.username,action:'board-fan',fan,success:false,error:e.message,restored});
                throw new Error(e.message+(restored?'；已恢复原设置':'；恢复状态未确认，请检查 BMC 风扇设置'));
            }
        });
        fanQueue=task.catch(()=>{});
        try {res.json({success:true,data:await task,message:'设置已保存并读回验证，开机自动恢复；实际 RPM 请等待下次采样'});} catch(e){res.status(503).json({success:false,error:e.message});}
    });
    const fanStartup=(async()=>{
        for(let attempt=0;attempt<3;attempt++) {
            try {
                const saved=readFanSettings();if(!Object.keys(saved).length)return;
                const model=(options.boardModel||fs.readFileSync('/sys/class/dmi/id/board_name','utf8')).trim();
                if(model!=='D1540D4U-2T8R')throw new Error('开机恢复主板型号不匹配');
                const before=await fanRegisters(),next=[...before];
                for(const [name,value] of Object.entries(saved))next[fanSlots[name]]=value;
                if(next.some((v,i)=>v!==before[i]))await writeFans(next);
                const after=await fanRegisters();
                if(after.some((v,i)=>v!==next[i]))throw new Error('开机恢复读回不一致');
                fanRestoreStatus='已恢复保存的配置';cache=null;
                try{audit({time:new Date().toISOString(),action:'board-fan-startup',success:true,saved});}catch(e){console.error(e.message);}
                return;
            }catch(e){fanRestoreStatus='开机恢复失败：'+e.message;console.error(fanRestoreStatus);if(attempt<2)await new Promise(r=>setTimeout(r,5000));}
        }
    })();
    fanQueue=fanStartup;
    // Quiet HDD-cage curve: target below 47°C without running FAN3 flat-out.
    // 100% remains reserved for loss of all reliable temperature telemetry.
    const diskFanCurve=[
        {max:35,percent:35},{max:39,percent:45},{max:42,percent:55},
        {max:44,percent:65},{max:46,percent:75},{max:Infinity,percent:85}
    ];
    let diskFanState={enabled:false,fan:'FRNT_FAN3',status:'等待首次采样',maxTemp:null,hottestDisk:null,targetPercent:null,appliedPercent:null,temperatures:[],lastUpdate:null};
    let lowerTargetSamples=0,diskFanRunning=false;
    const targetForTemp=temp=>diskFanCurve.find(step=>temp<=step.max).percent;
    function parseSmartTemperature(text) {
        for(const re of [
            /Current Drive Temperature:\s*(\d+)\s*C/i,
            /Drive Temperature:\s*(\d+)\s*C/i,
            /Temperature Sensor \d+:\s*(\d+)\s*Celsius/i
        ]) {const m=text.match(re);if(m&&Number(m[1])>0&&Number(m[1])<100)return Number(m[1]);}
        for(const line of text.split('\n')) {
            if(!/(Temperature_Celsius|Airflow_Temperature_Cel)/.test(line))continue;
            const m=line.match(/-\s+(\d+)(?:\s|\()/);
            if(m&&Number(m[1])>0&&Number(m[1])<100)return Number(m[1]);
        }
        return null;
    }
    async function readDiskTemperatures() {
        const {stdout}=await run('/usr/bin/lsblk',['-dn','-b','-P','-o','NAME,SIZE,ROTA,TYPE,MODEL'],{timeout:10000,maxBuffer:1024*1024,env:{...process.env,LC_ALL:'C'}});
        const disks=stdout.split('\n').map(line=>Object.fromEntries([...line.matchAll(/(\w+)="([^"]*)"/g)].map(m=>[m[1],m[2]]))).filter(d=>d.TYPE==='disk'&&d.ROTA==='1'&&Number(d.SIZE)>0&&/^sd[a-z]+$/.test(d.NAME));
        const samples=await Promise.all(disks.map(async d=>{
            let text='',standby=false;
            try {text=(await run('/usr/sbin/smartctl',['-n','standby','-a','/dev/'+d.NAME],{timeout:10000,maxBuffer:2*1024*1024,env:{...process.env,LC_ALL:'C'}})).stdout||'';}
            catch(e){text=(e.stdout||'')+'\n'+(e.stderr||'');}
            standby=/STANDBY|SLEEP mode/i.test(text);
            return {name:d.NAME,model:d.MODEL.trim(),temperature:parseSmartTemperature(text),standby};
        }));
        return samples;
    }
    async function runDiskFanCycle() {
        if(diskFanRunning)return;
        diskFanRunning=true;
        try {
            const cfg=readFanConfig(),enabled=cfg.policies.FRNT_FAN3==='disk-temp';
            diskFanState.enabled=enabled;
            if(!enabled){diskFanState={...diskFanState,enabled:false,status:'硬盘温控未启用'};return;}
            const samples=await readDiskTemperatures(),measured=samples.filter(s=>Number.isFinite(s.temperature));
            let desired,maxTemp=null,hottestDisk=null,status;
            if(measured.length) {
                const hottest=measured.reduce((a,b)=>b.temperature>a.temperature?b:a);
                maxTemp=hottest.temperature;hottestDisk=hottest.name;desired=targetForTemp(maxTemp);
                status=`跟随最高盘温：/dev/${hottestDisk} · ${maxTemp}°C`;
            } else if(samples.length&&samples.every(s=>s.standby)) {
                desired=35;status='所有机械硬盘均处于休眠，保持低速散热';
            } else {
                desired=100;status='无法取得可靠硬盘温度，已进入 100% 故障保护';
            }
            const applyTask=fanQueue.then(async()=>{
                const liveCfg=readFanConfig();
                if(liveCfg.policies.FRNT_FAN3!=='disk-temp')return null;
                const regs=await fanRegisters(),current=regs[fanSlots.FRNT_FAN3];
                if(desired<current) {
                    lowerTargetSamples++;
                    if(lowerTargetSamples<3)desired=current;
                } else lowerTargetSamples=0;
                if(desired!==current) {
                    const next=[...regs];next[fanSlots.FRNT_FAN3]=desired;
                    await writeFans(next);
                    const after=await fanRegisters();
                    if(after[fanSlots.FRNT_FAN3]!==desired)throw new Error('FAN3 温控参数读回不一致');
                    saveFanSettings({...liveCfg.fans,FRNT_FAN3:desired},liveCfg.policies);
                }
                return desired;
            });
            fanQueue=applyTask.catch(()=>{});
            const applied=await applyTask;
            if(applied===null){diskFanState={...diskFanState,enabled:false,status:'硬盘温控未启用'};return;}
            desired=applied;
            diskFanState={enabled:true,fan:'FRNT_FAN3',status,maxTemp,hottestDisk,targetPercent:desired,appliedPercent:desired,temperatures:samples,lastUpdate:Date.now(),curve:diskFanCurve.map(s=>({max:Number.isFinite(s.max)?s.max:null,percent:s.percent}))};
            cache=null;
        } catch(e) {
            diskFanState={...diskFanState,enabled:true,status:'温控异常：'+e.message,lastUpdate:Date.now()};
            try {
                const regs=await fanRegisters();
                if(regs[fanSlots.FRNT_FAN3]!==100){const next=[...regs];next[fanSlots.FRNT_FAN3]=100;await writeFans(next);}
                diskFanState.targetPercent=100;diskFanState.appliedPercent=100;
            } catch(_) {}
        } finally {diskFanRunning=false;}
    }
    fanStartup.then(()=>runDiskFanCycle());
    const diskFanTimer=setInterval(runDiskFanCycle,30000);diskFanTimer.unref();
    async function snapshot() {
        if (cache && Date.now() - cache.timestamp < 15000) return cache;
        if (pending) return pending;
        pending = (async () => {
            const errors = [];
            async function get(args) { try { return (await ipmi(args)).stdout; } catch(e) { errors.push(args.join(' ') + ': ' + (e.stderr || e.message).trim().slice(0,300)); return ''; } }
            const mc = pairs(await get(['mc','info']));
            const status = pairs(await get(['chassis','status']));
            const sensorText = await get(['sdr','elist']);
            const numericText = await get(['sensor']);
            let fanControl=null;
            try {const regs=await fanRegisters(),cfg=readFanConfig();fanControl=Object.fromEntries(Object.entries(fanSlots).map(([name,index])=>[name,{mode:name==='FRNT_FAN3'&&cfg.policies.FRNT_FAN3==='disk-temp'?'disk-temp':regs[index]===0?'auto':'manual',percent:regs[index],rpmVerified:name==='FRNT_FAN4'}]));} catch(e){errors.push('风扇控制状态: '+e.message);}
            const number = v => v && v !== 'na' && Number.isFinite(Number(v)) ? Number(v) : null;
            const hardwareSensors = numericText.split('\n').map(l => l.split('|').map(v => v.trim())).filter(p => p.length >= 10 && /^(RPM|degrees C)$/.test(p[2])).map(p => ({name:p[0],value:number(p[1]),unit:p[2],status:p[3],thresholds:{lowerCritical:number(p[5]),lowerWarning:number(p[6]),upperWarning:number(p[7]),upperCritical:number(p[8])}}));
            const dcmi = await get(['dcmi','power','reading']);
            const policies = await get(['chassis','policy','list']);
            const events = await get(['sel','elist','last','30']);
            const sensors = sensorText.split('\n').map(l => l.split('|').map(v => v.trim())).filter(p => p.length >= 5).map(p => ({name:p[0],id:p[1],status:p[2],reading:p.slice(4).join(' | ')}));
            const psus = sensors.filter(s => /PSU|Power Supply/i.test(s.name)).map(s => ({...s,
                present: /Presence detected/i.test(s.reading) ? true : /absent|not present/i.test(s.reading) ? false : null,
                fault: /failure|AC lost|out.of.range|Config Error/i.test(s.reading) || ['cr','nr','nc'].includes(s.status),
                controlSupported:false,temperatureC:null,fanRpm:null,inputWatts:null,outputWatts:null,fanControlSupported:false
            }));
            const activeMeter = /Power reading state is:\s*activated/i.test(dcmi);
            const watts = activeMeter ? Number(dcmi.match(/Instantaneous power reading:\s*(\d+)/i)?.[1]) : NaN;
            const data = {equipment:{manufacturer:'Great Wall / 浪潮与长城联合研制',model:'GW-ERP2U700(90+)-2H',ratedWatts:700,source:'用户提供的电源组件铭牌；非逐模块自动识别'},timestamp:Date.now(),available:Boolean(mc['Device ID']),bmc:mc,status,psus,
                sensors:sensors.filter(s => /volt|watt|amp/i.test(s.reading)),
                temperatures:hardwareSensors.filter(s => s.unit === 'degrees C'),
                fans:hardwareSensors.filter(s => s.unit === 'RPM'),
                fanControl,
                diskFanPolicy:diskFanState,
                fanRestoreStatus,
                watts:Number.isFinite(watts) ? watts : null,
                meteringNote:activeMeter ? 'BMC DCMI 实测' : 'BMC 功率采样未激活，暂无可信瓦数',
                redundancy:'未提供冗余策略遥测；两路在位不等于已验证冗余供电',
                capabilities:{individualPsu:false,redundancyPolicy:false,restorePolicies:['always-off','always-on','previous'].filter(p => policies.includes(p)),osShutdown:true,osReboot:true},
                unsupportedReason:'当前 BMC 仅上报 PSU 在位/故障，未开放 PSU 内部温度、风扇转速和功率读数；调速、单路开关及冗余策略均未验证。',
                events:events.split('\n').filter(l => /power|PSU/i.test(l)),errors};
            cache=data; return data;
        })().finally(() => {pending=null;});
        return pending;
    }
    app.get('/api/server-power', async(req,res) => {
        try { res.json({success:true,data:{...await snapshot(),energy:require('./energy-meter').reading()}}); }
        catch(e) {res.status(503).json({success:false,error:e.message});}
    });
    app.post('/api/server-power/control', async(req,res) => {
        if (req.sessionUser?.role !== 'Administrator') return res.status(403).json({success:false,error:'仅管理员可执行电源控制'});
        const {action,value,confirmation} = req.body || {};
        if (!['shutdown','reboot','cancel','restore-policy'].includes(action)) return res.status(400).json({success:false,error:'不支持的电源操作'});
        if (confirmation !== 'CONFIRM ' + action) return res.status(400).json({success:false,error:'缺少操作确认'});
        if (action === 'restore-policy' && !['always-off','always-on','previous'].includes(value)) return res.status(400).json({success:false,error:'无效的来电策略'});
        const record={time:new Date().toISOString(),user:req.sessionUser.username,action,value};
        try {
            if (action === 'restore-policy') {
                const data=await snapshot();
                if (!data.capabilities.restorePolicies.includes(value)) return res.status(409).json({success:false,error:'BMC 未报告支持此来电策略'});
                await ipmi(['chassis','policy',value]);
                cache=null;
                const verified=pairs((await ipmi(['chassis','status'])).stdout)['Power Restore Policy'];
                if (verified !== value) throw new Error('策略写入后的读回值不匹配，请刷新核对');
            } else {
                const args=action==='cancel'?['-c']: [action==='shutdown'?'-h':'-r','+1','Requested from Network Monitor'];
                await command('/usr/sbin/shutdown',args);
            }
            audit({...record,success:true});
            res.json({success:true,message:action==='restore-policy'?'来电策略已写入并读回验证':action==='cancel'?'已取消计划关机/重启':'已安排在 1 分钟后执行，可在本页取消'});
        } catch(e) {
            audit({...record,success:false,error:e.message});
            res.status(500).json({success:false,error:(e.stderr || e.message).slice(0,500)});
        }
    });
    return {fanStartup};
};
