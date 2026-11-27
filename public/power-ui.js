let powerFetching=false,powerFetchedAt=0;
let boardFanBusy=false;
const boardFanDrafts={};
function renderFanControls(d) {
 powerText('board-fan-persistence',d.fanRestoreStatus||'正在读取保存状态');
 const root=document.getElementById('board-fan-controls');
 if(boardFanBusy || root.contains(document.activeElement)) return;
 root.innerHTML=[1,2,3,4].map(n=>{
  const name='FRNT_FAN'+n,s=d.fanControl?.[name],rpm=d.fans?.find(f=>f.name===name)?.value;
  const value=boardFanDrafts[name]??(s?.mode==='manual'?s.percent:60);
  const modeLabel=s?.mode==='disk-temp'?'硬盘温控 · '+s.percent+'%':s?.mode==='auto'?'主板自动':s?s.percent+'% 手动':'状态不可用';
  const diskInfo=n===3&&d.diskFanPolicy?`<p class="ops-muted">${escapeHtml(d.diskFanPolicy.status||'')} ${Number.isFinite(d.diskFanPolicy.maxTemp)?'· 最高 '+d.diskFanPolicy.maxTemp+'°C':''}</p>`:'';
  return `<div style="padding:16px;border:1px solid rgba(128,128,128,.2);border-radius:12px"><div class="ops-panel-heading"><strong>FAN${n}</strong><span class="ops-tag">${modeLabel}</span></div><p class="ops-muted">${Number.isFinite(rpm)?rpm+' RPM':'暂无转速反馈'} · ${s?.rpmVerified?'已实测调速响应':'实际响应未验证'}</p>${diskInfo}<label class="ops-label" for="fan-duty-${n}">手动占空比 %</label><input class="form-input" style="width:100%;box-sizing:border-box" id="fan-duty-${n}" type="number" min="30" max="100" step="1" value="${escapeHtml(String(value))}" oninput="boardFanDrafts['${name}']=this.value"><div class="ops-actions" style="margin-top:12px"><button class="btn btn-primary" ${s?'':'disabled'} onclick="applyBoardFan(${n},'manual')">应用</button><button class="btn btn-secondary" ${s?'':'disabled'} onclick="applyBoardFan(${n},'auto')">主板自动</button>${n===3?'<button class="btn btn-secondary" onclick="applyBoardFan(3,\'disk-temp\')">硬盘温控</button>':''}</div></div>`;
 }).join('');
}
async function applyBoardFan(n,mode) {
 if(boardFanBusy)return;
 const percent=Number(document.getElementById('fan-duty-'+n).value);
 if(mode==='manual'&&(!Number.isInteger(percent)||percent<30||percent>100)){powerText('board-fan-result','请输入 30–100 的整数百分比');return;}
 boardFanBusy=true;
 document.querySelectorAll('#board-fan-controls button').forEach(b=>b.disabled=true);
 powerText('board-fan-result','正在写入 FAN'+n+' 并核对读回值…');
 try {
  const response=await apiFetch('/api/board-fans/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fan:'FRNT_FAN'+n,mode,percent})});
  const j=await response.json();if(!j.success)throw new Error(j.error||'设置失败');
  powerText('board-fan-result','FAN'+n+'：'+(mode==='auto'?'已恢复主板自动':mode==='disk-temp'?'已启用硬盘最高温度联动':percent+'% 已生效')+'；'+j.message);
 } catch(e){powerText('board-fan-result','FAN'+n+'：'+e.message);}
 finally{boardFanBusy=false;document.activeElement?.blur();powerFetchedAt=0;await fetchServerPower(true);document.querySelectorAll('#board-fan-controls button').forEach(b=>b.disabled=false);}
}
function renderBoardSensors(d) {
 renderFanControls(d);
 const labels={'MB Temp':'主板','Card Side Temp':'扩展卡区域','CPU Temp':'处理器','X540 Temp':'X540 万兆网卡','DDR4_A Temp':'内存 A 区','DDR4_B Temp':'内存 B 区','TR1 Temp':'外接温度探头','CPU_FAN1':'CPU 风扇','REAR_FAN1':'后置风扇','FRNT_FAN1':'前置风扇 1','FRNT_FAN2':'前置风扇 2','FRNT_FAN3':'前置风扇 3','FRNT_FAN4':'前置风扇 4'};
 for(const [key,id,count,unit] of [['temperatures','board-temperatures','board-temp-count','°C'],['fans','board-fans','board-fan-count','RPM']]) {
  const rows=d[key]||[];
  document.getElementById(count).textContent=rows.filter(s=>Number.isFinite(s.value)).length+' / '+rows.length+' 有读数';
  document.getElementById(id).innerHTML=rows.map(s=>{
   const valid=Number.isFinite(s.value),t=s.thresholds||{},ok=s.status==='ok';
   const limits=[['低告警',t.lowerWarning],['低临界',t.lowerCritical],['高告警',t.upperWarning],['高临界',t.upperCritical]].filter(x=>Number.isFinite(x[1])).map(x=>x[0]+' '+x[1]+' '+unit).join(' · ');
   return `<div style="padding:14px 0;border-bottom:1px solid var(--border-color,rgba(128,128,128,.18))"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><div><strong>${escapeHtml(labels[s.name]||s.name)}</strong><div class="ops-muted" style="font-size:12px">${escapeHtml(s.name)}</div></div><div style="text-align:right"><strong style="font-size:23px;font-variant-numeric:tabular-nums">${valid?escapeHtml(String(s.value)):'—'}</strong> <span class="ops-muted">${unit}</span><div><span class="ops-tag ${valid?(ok?'good':'amber'):''}">${valid?(ok?'正常':escapeHtml(s.status)):'暂无读数'}</span></div></div></div><div class="ops-muted" style="font-size:12px;margin-top:6px">${escapeHtml(limits||'BMC 未提供告警阈值')}</div></div>`;
  }).join('')||'<p class="ops-muted">未获取到传感器列表</p>';
 }
}
const powerText=(id,text)=>{const e=document.getElementById(id);if(e)e.textContent=text;};
const powerNumber=(id,value,unit)=>{const e=document.getElementById(id);if(e)e.innerHTML=(Number.isFinite(value)?value.toFixed(1):'—')+'<small>'+escapeHtml(unit)+'</small>';};
async function fetchServerPower(force=false) {
 if(powerFetching||(!force&&Date.now()-powerFetchedAt<3000))return;
 powerFetching=true;
 try {
  const response=await apiFetch('/api/server-power');const json=await response.json();
  if(!json.success)throw new Error(json.error||'读取失败');
  const d=json.data;powerFetchedAt=Date.now();
  renderBoardSensors(d);
  powerText('power-status',d.available?'BMC 在线':'BMC 未连接');
  powerText('power-timestamp','BMC 采样 '+new Date(d.timestamp).toLocaleTimeString());
  powerNumber('power-total-watts',d.watts,'W');
  powerText('power-meter-note',d.watts===null?'未收到有效功率遥测':'DCMI · 整机实测');
  const domains=d.energy?.domains||[];
  for(const [id,name] of [['power-cpu-watts','package-0'],['power-dram-watts','dram']]){const val=domains.find(p=>p.name===name)?.watts;powerText(id,Number.isFinite(val)?val.toFixed(2)+' W':'未提供');}
  const present=d.psus.filter(p=>p.present===true).length;
  document.getElementById('power-psu-count').innerHTML=present+'<small>/ '+d.psus.length+' 在位</small>';
  powerText('power-psu-summary',d.psus.some(p=>p.fault)?'检测到电源告警':'当前未报告电源故障');
  powerText('power-note','型号与额定值来自电源组件铭牌，非逐模块自动识别。在位状态不等于已验证冗余供电。');
  const temps=d.psus.map(p=>p.temperatureC).filter(Number.isFinite),fans=d.psus.map(p=>p.fanRpm).filter(Number.isFinite);
  powerNumber('power-psu-temp',temps.length?Math.max(...temps):null,'°C');
  powerNumber('power-psu-fan',fans.length?Math.max(...fans):null,'RPM');
  const fmt=(n,u)=>Number.isFinite(n)?escapeHtml(n+' '+u):'<span class="ops-muted">未上报</span>';
  document.getElementById('power-psus').innerHTML=d.psus.map(p=>`<article class="ops-psu"><div class="ops-psu-graphic" aria-hidden="true"><span class="ops-psu-led" style="${p.fault?'background:#ff9393':p.present?'':'background:#8293a8'}"></span></div><div><div class="ops-psu-title"><h4>${escapeHtml(p.name.replace(/ Status$/,''))}</h4><span class="ops-tag ${p.fault?'bad':p.present?'good':''}">${p.fault?'电源告警':p.present?'已在位':'状态未知'}</span></div><dl><dt>输入 / 输出功率</dt><dd>${fmt(p.inputWatts,'W')} / ${fmt(p.outputWatts,'W')}</dd><dt>内部温度</dt><dd>${fmt(p.temperatureC,'°C')}</dd><dt>内置风扇</dt><dd>${fmt(p.fanRpm,'RPM')}</dd></dl><details class="ops-details"><summary>模块诊断与控制</summary><p>${escapeHtml(p.reading||'无状态读数')}</p><p>温度、风扇和功率采集通道尚未接通；当前没有已验证的调速写接口。</p><button class="btn btn-secondary" disabled>PSU 风扇调速待接入</button></details></div></article>`).join('')||'<article class="ops-panel">没有发现 PSU 传感器</article>';
  powerText('power-capabilities',d.unsupportedReason);
  document.getElementById('power-sensors').innerHTML=d.sensors.map(s=>`<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.reading)}</td><td><span class="ops-tag ${s.status==='ok'?'good':'amber'}">${s.status==='ok'?'正常':escapeHtml(s.status)}</span></td></tr>`).join('')||'<tr><td colspan="3">无电压数据</td></tr>';
  document.getElementById('power-events').innerHTML=d.events.length?d.events.slice(-5).reverse().map(e=>{const p=e.split('|').map(s=>s.trim());return `<div class="ops-event"><i></i><div>${escapeHtml((p[3]||'电源事件')+' · '+(p[4]||''))}<small>${escapeHtml(p.slice(0,3).join(' / '))}</small></div></div>`;}).join(''):'<p class="ops-muted">最近记录中没有电源事件</p>';
  powerText('power-errors',d.errors.join('\n')||'本次采集无异常。');
  const labels={'always-off':'来电后保持关机','always-on':'来电后自动开机',previous:'恢复断电前状态'};
  const select=document.getElementById('power-restore-policy');
  if(document.activeElement!==select){const old=select.value;select.innerHTML=d.capabilities.restorePolicies.map(v=>`<option value="${v}">${labels[v]}</option>`).join('');select.value=d.capabilities.restorePolicies.includes(old)?old:d.status['Power Restore Policy'];}
  document.getElementById('power-apply-policy').disabled=!d.capabilities.restorePolicies.length;
 } catch(e) {powerText('power-status','采集失败');powerText('power-timestamp','旧数据 · '+e.message);}
 finally {powerFetching=false;}
}
async function serverPowerControl(action) {
 const value=document.getElementById('power-restore-policy').value;
 const labels={shutdown:'1 分钟后正常关闭整台服务器。面板与 SSH 将断开；再次开机需独立 BMC 或实体按钮。',reboot:'1 分钟后正常重启整台服务器。面板与 SSH 将暂时断开。',cancel:'取消已安排的关机或重启。','restore-policy':'更改断电恢复后的整机开机策略为：'+value+'。这不是 PSU 冗余策略。'};
 if(!Object.hasOwn(labels,action))return;const phrase='CONFIRM '+action;
 if(prompt(labels[action]+'\n输入 '+phrase+' 确认执行：')!==phrase)return;
 const buttons=[...document.querySelectorAll('#power-controls button')];buttons.forEach(b=>b.disabled=true);
 try {const r=await apiFetch('/api/server-power/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value,confirmation:phrase})});const j=await r.json();powerText('power-action-result',j.success?j.message:'操作失败：'+j.error);if(j.success){powerFetchedAt=0;await fetchServerPower(true);}}
 catch(e){powerText('power-action-result','操作结果未确认：'+e.message);}
 finally{buttons.forEach(b=>b.disabled=false);}
}
