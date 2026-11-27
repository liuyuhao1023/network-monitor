// ═══ Host Client Controller for KVM ═══
let vmSelected = null, vmIsoSignature = '', vmUploadXHR = null;
let vmBusy = false, vmFetching = false, vmListSignature = '', vmInventory = null, vmRfb = null;
let vmBackupsData = null;
let esxiCurrentView = 'vms';
let esxiSelectedDatastore = 'datastore-raid10';

const vmState = {
  1: '已打开电源',
  2: '已打开电源',
  3: '已挂起',
  4: '正在关机',
  5: '已关闭电源',
  6: '异常退出',
  7: '挂起'
};

function getVmOsText(v) {
  const n = (v?.name || '').toLowerCase();
  if (n.includes('feiniu') || n.includes('fnos')) return 'Linux (64 位) · fnOS 飞牛私有云 NAS';
  if (n.includes('istore') || n.includes('openwrt')) return 'Linux (64 位) · iStoreOS / OpenWrt 软路由系统';
  if (n.includes('ubuntu')) return 'Linux (64 位) · Ubuntu Server';
  if (n.includes('debian')) return 'Linux (64 位) · Debian GNU/Linux';
  if (n.includes('win')) return 'Microsoft Windows (64 位)';
  return 'Linux (64 位) · 标准虚拟机';
}


function vmMessage(s) {
  const el = document.getElementById('vm-message');
  if (el) el.textContent = s;
}

async function vmRequest(body) {
  const r = await apiFetch('/api/vms/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.success) throw Error(j.error);
  return j.data;
}

/* ─── Navigation & Views ─── */
function esxiSwitchView(viewName) {
  esxiCurrentView = viewName;
  document.querySelectorAll('.esxi-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewName);
  });
  const views = ['host', 'vms', 'cts', 'datastores', 'networking', 'backups'];
  const titles = {
    host: '主机概览',
    vms: '虚拟机',
    cts: 'CT 容器',
    datastores: '存储管理',
    networking: '虚拟网络',
    backups: '系统盘备份'
  };
  views.forEach(v => {
    const el = document.getElementById(`esxi-view-${v}`);
    if (el) el.style.display = (v === viewName) ? 'block' : 'none';
  });
  const crumb = document.getElementById('esxi-current-crumb');
  if (crumb) crumb.textContent = titles[viewName] || viewName;

  if (viewName === 'cts') fetchCts();
  if (viewName === 'datastores') esxiRenderDatastores();
  else if (viewName === 'backups') vmFetchBackups();
  else if (viewName === 'networking') esxiRenderNetworking();
  else if (viewName === 'host') esxiRenderHostOverview();
}


/* ─── Navigator Widgets & State Filter ─── */
let esxiVmStateFilter = 'all';

function esxiFilterVmTable(stateFilter) {
  if (esxiVmStateFilter === stateFilter) {
    esxiVmStateFilter = 'all';
  } else {
    esxiVmStateFilter = stateFilter;
  }
  document.querySelectorAll('.esxi-nav-stat-card').forEach(el => {
    el.classList.toggle('active-filter', el.classList.contains(esxiVmStateFilter));
  });
  if (vmInventory) {
    vmListSignature = '';
    esxiRenderVmTable(vmInventory);
  }
}

function esxiRenderNavigatorWidgets(d) {
  if (!d || !d.vms) return;
  // 1. VM state counts
  const running = d.vms.filter(v => v.state === 1 || v.state === 2).length;
  const paused = d.vms.filter(v => v.state === 3).length;
  const off = d.vms.filter(v => v.state === 5).length;

  const elRun = document.getElementById('esxi-stat-running');
  if (elRun) elRun.textContent = running;
  const elPause = document.getElementById('esxi-stat-paused');
  if (elPause) elPause.textContent = paused;
  const elOff = document.getElementById('esxi-stat-off');
  if (elOff) elOff.textContent = off;

  // 2. CPU Allocation Gauge
  const totalHostCpus = d.cpus || 16;
  const allocCpus = d.vms.reduce((acc, v) => acc + (v.cpu || 0), 0);
  const cpuPct = Math.min(100, Math.round((allocCpus / totalHostCpus) * 100));
  const elCpuText = document.getElementById('esxi-gauge-cpu-text');
  if (elCpuText) elCpuText.textContent = `${allocCpus} / ${totalHostCpus} 核 (${cpuPct}%)`;
  const elCpuBar = document.getElementById('esxi-gauge-cpu-bar');
  if (elCpuBar) elCpuBar.style.width = `${cpuPct}%`;

  // 3. RAM Allocation Gauge
  const totalHostMemGiB = (d.memoryMiB / 1024) || 31.2;
  const allocMemGiB = d.vms.reduce((acc, v) => acc + ((v.memory || 0) / 1024), 0);
  const memPct = Math.min(100, Math.round((allocMemGiB / totalHostMemGiB) * 100));
  const elMemText = document.getElementById('esxi-gauge-mem-text');
  if (elMemText) elMemText.textContent = `${allocMemGiB.toFixed(1)} / ${totalHostMemGiB.toFixed(1)} GiB (${memPct}%)`;
  const elMemBar = document.getElementById('esxi-gauge-mem-bar');
  if (elMemBar) elMemBar.style.width = `${memPct}%`;

  // 4. Storage Pool Gauge
  const freeGiB = d.freeGiB || 0;
  const elDsText = document.getElementById('esxi-gauge-ds-text');
  if (elDsText) {
    if (freeGiB >= 1024) {
      elDsText.textContent = `剩余 ${(freeGiB / 1024).toFixed(1)} TiB`;
    } else {
      elDsText.textContent = `剩余 ${freeGiB} GiB`;
    }
  }
}

async function vmCreateBackupNow(id) {
  if (!id) id = vmSelected;
  if (!id) return alert('请先选择一台虚拟机');
  const v = vmInventory?.vms?.find(x => x.id === id);
  const name = v ? v.name : id;
  if (!confirm(`确认立即为虚拟机【${name}】创建系统盘快照备份？`)) return;

  try {
    vmMessage(`正在为【${name}】创建系统盘快照备份…`);
    await vmControl(id, 'backup-create');
    alert(`虚拟机【${name}】系统盘快照已成功创建！`);
    if (typeof vmFetchBackups === 'function') vmFetchBackups(true);
    if (typeof fetchVMs === 'function') fetchVMs();
  } catch (e) {
    alert(`创建快照失败: ${e.message}`);
  }
}

function esxiRenderVmBackupColumn(v) {
  const badgeEl = document.getElementById('esxi-sum-bk-badge');
  const timeEl = document.getElementById('esxi-sum-bk-time');
  const fileEl = document.getElementById('esxi-sum-bk-file');
  const dirEl = document.getElementById('esxi-sum-bk-dir');
  const schedEl = document.getElementById('esxi-sum-bk-sched');
  const retEl = document.getElementById('esxi-sum-bk-ret');

  if (schedEl && vmBackupsData?.schedule) {
    schedEl.textContent = vmBackupsData.schedule.enabled ? `已启用 (每日 ${vmBackupsData.schedule.time})` : '未启用定时';
    schedEl.style.color = vmBackupsData.schedule.enabled ? '#22c55e' : '#8faec4';
  }
  if (retEl && vmBackupsData?.schedule) {
    retEl.textContent = `${vmBackupsData.schedule.retentionDays || 7} 天`;
  }
  if (dirEl && vmBackupsData?.targetDir) {
    dirEl.textContent = vmBackupsData.targetDir;
  }

  const vmNameClean = (v?.name || '').toLowerCase();
  const backups = vmBackupsData?.backups || [];
  const vmBackups = backups.filter(b => {
    const fn = (b.filename || '').toLowerCase();
    const bn = (b.vmName || '').toLowerCase();
    return bn === vmNameClean || fn.startsWith(vmNameClean + '_') || fn.includes(vmNameClean);
  });

  if (vmBackups.length > 0) {
    const latest = vmBackups[0];
    if (badgeEl) {
      badgeEl.className = 'ops-tag good';
      badgeEl.textContent = '已受保护';
    }
    if (timeEl) timeEl.textContent = latest.createdAt || '近期已备份';
    if (fileEl) fileEl.textContent = `${latest.filename} (${latest.sizeFormatted || vmSize(latest.size)})`;
  } else {
    if (badgeEl) {
      badgeEl.className = 'ops-tag warning';
      badgeEl.textContent = '无历史快照';
    }
    if (timeEl) timeEl.textContent = '尚无系统盘快照';
    if (fileEl) fileEl.textContent = '建议创建首次系统盘保护备份';
  }
}

/* ─── Fetch Inventory ─── */
async function fetchVMs() {
  if (vmFetching) return;
  vmFetching = true;
  try {
    const r = await apiFetch('/api/vms');
    const j = await r.json();
    if (!j.success) throw Error(j.error);
    const d = j.data;
    vmInventory = d;
    esxiRenderNavigatorWidgets(d);
    // Background fetch CT counts for navigator badge
    if (!ctInventory && !ctFetching) {
      fetchCts().catch(() => {});
    }

    // Background load backup data for details column 3 if not yet loaded
    if (!vmBackupsData) {
      apiFetch("/api/vms/backups").then(r => r.json()).then(j => {
        if (j && j.success) {
          vmBackupsData = j.data;
          const v = vmInventory?.vms?.find(x => x.id === vmSelected);
          if (v) esxiRenderVmBackupColumn(v);
        }
      }).catch(() => {});
    }

    // Badges & Host Header
    const badgeVms = document.getElementById('esxi-badge-vms');
    if (badgeVms) badgeVms.textContent = d.vms.length;
    const badgeDs = document.getElementById('esxi-badge-ds');
    if (badgeDs) badgeDs.textContent = d.datastores ? d.datastores.length : 3;

    const quickInfo = document.getElementById('esxi-quickinfo');
    if (quickInfo) {
      quickInfo.textContent = `Ubuntu 24.04 LTS · KVM / QEMU 8.2 · ${d.cpus} vCPUs · ${(d.memoryMiB / 1024).toFixed(1)} GiB RAM · 剩余存储 ${d.freeGiB} GiB`;
    }

    // Populate ISO dropdown & Firmware dropdown in create modal & mount dialog
    const allImgs = d.isos || [];
    const isoImgs = allImgs.filter(i => (i.imageType === 'iso' || i.name.toLowerCase().endsWith('.iso')));
    const fwImgs = allImgs.filter(i => (i.imageType === 'firmware' || !i.name.toLowerCase().endsWith('.iso')));

    const isoOptions = '<option value="">不挂载镜像</option>' + isoImgs.map(i => {
      const dsBadge = i.datastore ? `[${i.datastore}] ` : '';
      return `<option value="${escapeHtml(i.name)}">${dsBadge}${escapeHtml(i.name)} (${vmSize(i.size)})</option>`;
    }).join('');

    const fwOptions = fwImgs.length
      ? fwImgs.map(i => {
          const dsBadge = i.datastore ? `[${i.datastore}] ` : '';
          return `<option value="${escapeHtml(i.name)}">${dsBadge}${escapeHtml(i.name)} (${vmSize(i.size)})</option>`;
        }).join('')
      : '<option value="">(暂无固件母盘，请先在存储浏览器中上传)</option>';

    const newIsoSelect = document.getElementById('vm-new-iso');
    if (newIsoSelect && newIsoSelect.dataset.options !== isoOptions) {
      const old = newIsoSelect.value;
      newIsoSelect.innerHTML = isoOptions;
      if (old) newIsoSelect.value = old;
      newIsoSelect.dataset.options = isoOptions;
    }

    const newFwSelect = document.getElementById('vm-new-firmware');
    if (newFwSelect && newFwSelect.dataset.options !== fwOptions) {
      const old = newFwSelect.value;
      newFwSelect.innerHTML = fwOptions;
      if (old) newFwSelect.value = old;
      newFwSelect.dataset.options = fwOptions;
    }

    // Populate Network interfaces in create modal
    if (d.networkInterfaces) {
      const netSelect = document.getElementById('vm-new-net-dev');
      if (netSelect) {
        const old = netSelect.value;
        netSelect.innerHTML = d.networkInterfaces.map(i =>
          `<option value="${escapeHtml(i.name)}" ${i.isDefault ? 'selected' : ''}>${escapeHtml(i.desc)}</option>`
        ).join('');
        if (old) netSelect.value = old;
      }
    }

    // Render DataGrid and Summary
    esxiRenderVmTable(d);

    // If on datastores view, update it
    if (esxiCurrentView === 'datastores') esxiRenderDatastores();
    if (esxiCurrentView === 'host') esxiRenderHostOverview();
    if (esxiCurrentView === 'networking') esxiRenderNetworking();

    esxiFetchRecentTasks();
  } catch (e) {
    vmMessage('读取失败：' + e.message);
  } finally {
    vmFetching = false;
  }
}

/* ─── Render VM DataGrid ─── */
function esxiRenderVmTable(d) {
  const tbody = document.getElementById('esxi-vm-table-body');
  if (!tbody) return;

  if (!d.vms.some(v => v.id === vmSelected)) {
    vmSelected = d.vms[0]?.id || null;
  }

  if (!d.vms.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:#8faec4;">暂无虚拟机。点击上方【创建虚拟机】构建您的第一台虚拟机。</td></tr>`;
    const wrap = document.getElementById('esxi-vm-details-wrapper');
    if (wrap) wrap.style.display = 'none';
    esxiUpdateToolbarButtons(null);
    return;
  }

  const filteredVms = d.vms.filter(v => {
    if (esxiVmStateFilter === 'running') return v.state === 1 || v.state === 2;
    if (esxiVmStateFilter === 'paused') return v.state === 3;
    if (esxiVmStateFilter === 'off') return v.state === 5;
    return true;
  });
  const vmsSig = filteredVms.map(v => `${v.id}:${v.state}:${v.cpu}:${v.memory}:${v.ips?.join(',')}:${v.diskSize}`).join('|') + `|selected:${vmSelected}|filter:${esxiVmStateFilter}`;
  if (vmsSig !== vmListSignature || tbody.children.length === 0) {
    vmListSignature = vmsSig;
    tbody.innerHTML = filteredVms.map(v => {
      const isRunning = (v.state === 1 || v.state === 2);
      const isPaused = (v.state === 3);
      const isSelected = (v.id === vmSelected);
      const ips = v.ips && v.ips.length ? v.ips.join(', ') : '—';
      const osName = getVmOsText(v);
      let statusIcon = '';
      if (isRunning) {
        statusIcon = '<span style="color:#22c55e;font-size:14px;margin-right:6px;">●</span>已打开电源';
      } else if (isPaused) {
        statusIcon = '<span style="color:#f59e0b;font-size:14px;margin-right:6px;">⏸</span>已挂起';
      } else {
        statusIcon = '<span style="color:#64748b;font-size:14px;margin-right:6px;">■</span>已关闭电源';
      }

      // Total provisioned disk space
      const sysDisk = (v.disks || []).find(x => x.device === 'disk' && x.type === 'file');
      const sysCap = sysDisk?.capacityGiB || v.diskSize || 32;
      let diskDesc = `系统盘 ${sysCap} GiB`;
      const rawDisks = (v.disks || []).filter(x => x.type === 'block');
      if (rawDisks.length) diskDesc += ` + ${rawDisks.length}x 直通物理盘`;

      return `
        <tr data-vmid="${v.id}" class="${isSelected ? 'selected' : ''}" onclick="esxiSelectVm('${v.id}')" ondblclick="esxiVmAction('console')">
          <td style="text-align:center;"><span style="color:${isRunning ? '#22c55e' : (isPaused ? '#f59e0b' : '#64748b')}">▣</span></td>
          <td class="esxi-td-bold"><a href="javascript:void(0)" onclick="event.stopPropagation();esxiSelectVm('${v.id}')" class="esxi-vm-name-link">${escapeHtml(v.name)}</a></td>
          <td>${statusIcon}</td>
          <td>${escapeHtml(osName)}</td>
          <td>${v.cpu} vCPU</td>
          <td>${(v.memory / 1024).toFixed(1)} GiB</td>
          <td>${escapeHtml(diskDesc)}</td>
          <td style="color:#22c55e;font-family:monospace;">${escapeHtml(ips)}</td>
          <td>${v.autostart ? '<span class="ops-tag good">开启</span>' : '<span class="ops-tag">关闭</span>'}</td>
        </tr>
      `;
    }).join('');
  }

  esxiRenderVmSummary(d);
}

function esxiSelectVm(idOrName) {
  if (!idOrName) return;
  if (vmInventory?.vms) {
    const found = vmInventory.vms.find(x => x.id === idOrName || x.name === idOrName);
    vmSelected = found ? found.id : idOrName;
  } else {
    vmSelected = idOrName;
  }
  document.querySelectorAll('#esxi-vm-table-body tr').forEach(r => {
    if (r.getAttribute('data-vmid') === vmSelected) {
      r.classList.add('selected');
    } else {
      r.classList.remove('selected');
    }
  });
  if (vmInventory) {
    esxiRenderVmSummary(vmInventory);
  }
}

/* ─── Render 1:1 ESXi VM Summary View ─── */
function esxiRenderVmSummary(d) {
  const detailsWrap = document.getElementById('esxi-vm-details-wrapper');
  if (!detailsWrap) return;
  const v = d.vms.find(x => x.id === vmSelected);
  if (!v) {
    detailsWrap.style.display = 'none';
    esxiUpdateToolbarButtons(null);
    return;
  }
  detailsWrap.style.display = 'block';
  esxiUpdateToolbarButtons(v);
  esxiRenderVmBackupColumn(v);

  const isRunning = (v.state === 1 || v.state === 2);
  const isPaused = (v.state === 3);
  const isOff = (v.state === 5);

  document.getElementById('esxi-sum-name').textContent = v.name;
  const barName = document.getElementById('esxi-vm-bar-name');
  if (barName) barName.textContent = v.name;
  const osText = getVmOsText(v);
  document.getElementById('esxi-sum-sub').textContent = `${osText} · Q35 架构 (KVM 高性能虚拟化)`;
  document.getElementById('esxi-sum-os').textContent = osText;

  const badge = document.getElementById('esxi-sum-status-badge');
  if (isRunning) {
    badge.textContent = '已打开电源';
    badge.className = 'esxi-power-badge running';
  } else if (isPaused) {
    badge.textContent = '已挂起';
    badge.className = 'esxi-power-badge paused';
  } else {
    badge.textContent = '已关闭电源';
    badge.className = 'esxi-power-badge off';
  }

  // Console preview box & direct link
  const directLinkBox = document.getElementById('esxi-fnos-direct-link');
  const directLinkLabel = document.getElementById('esxi-direct-link-label');
  const directLinkUrl = document.getElementById('esxi-fnos-url');
  const ip = v.ips && v.ips.length ? v.ips[0] : '';
  const thumb = document.getElementById('esxi-console-thumb');
  const placeholder = document.getElementById('esxi-console-placeholder');

  const isFeiNiu = (v.name.toLowerCase().includes('feiniu') || v.name.toLowerCase().includes('fnos'));
  const isRouter = (v.name.toLowerCase().includes('istore') || v.name.toLowerCase().includes('openwrt'));
  const isWindows = (v.name.toLowerCase().includes('win'));

  if (isRunning) {
    if (thumb) {
      thumb.src = `/api/vms/screenshot?id=${encodeURIComponent(v.id)}&t=${Date.now()}`;
      thumb.style.display = 'block';
      thumb.onerror = () => {
        thumb.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
      };
      thumb.onload = () => {
        thumb.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
      };
    }
  } else {
    if (thumb) thumb.style.display = 'none';
    if (placeholder) {
      placeholder.style.display = 'flex';
      let icon = '<i class="fa-solid fa-display" style="font-size:32px;color:#0095d9;"></i>';
      if (isRouter) icon = '<i class="fa-solid fa-route" style="font-size:36px;color:#38bdf8;"></i>';
      else if (isWindows) icon = '<i class="fa-brands fa-windows" style="font-size:36px;color:#38bdf8;"></i>';

      let stateBadge = '';
      if (isRunning) {
        stateBadge = '<span style="font-size:12px;color:#22c55e;font-weight:600;"><span style="margin-right:4px;">●</span>正在运行</span>';
      } else if (isPaused) {
        stateBadge = '<span style="font-size:12px;color:#f59e0b;font-weight:600;"><span style="margin-right:4px;">⏸</span>已挂起</span>';
      } else {
        stateBadge = '<span style="font-size:12px;color:#8faec4;"><span style="margin-right:4px;">■</span>已关闭电源</span>';
      }

      placeholder.innerHTML = `
        ${icon}
        <div style="font-weight:700;font-size:13.5px;color:var(--esxi-text);margin-top:6px;">${escapeHtml(v.name)}</div>
        ${stateBadge}
        <span style="font-size:11px;color:#8faec4;margin-top:4px;">${isRunning ? '点击打开 Web 控制台' : '点击打开控制台窗口'}</span>
      `;
    }
  }

  // Web direct link
  if (isRunning && ip) {
    document.getElementById('esxi-sum-ips').textContent = v.ips.join(', ');
    if (directLinkBox) directLinkBox.style.display = 'block';
    let webUrl = '';
    if (isFeiNiu) {
      webUrl = `http://${ip}:5666`;
      if (directLinkLabel) directLinkLabel.textContent = 'fnOS 飞牛私有云 Web 直达: ';
    } else if (isRouter) {
      webUrl = `http://${ip}`;
      if (directLinkLabel) directLinkLabel.textContent = 'iStoreOS 软路由后台直达: ';
    } else {
      webUrl = `http://${ip}`;
      if (directLinkLabel) directLinkLabel.textContent = '客户机 Web 直达: ';
    }
    if (directLinkUrl) {
      directLinkUrl.textContent = webUrl;
      directLinkUrl.href = webUrl;
    }
  } else if (isRunning) {
    document.getElementById('esxi-sum-ips').textContent = '未检测到 IP (可打开 Web 控制台查看或配置静态 IP)';
    if (directLinkBox) directLinkBox.style.display = 'none';
  } else {
    document.getElementById('esxi-sum-ips').textContent = '—';
    if (directLinkBox) directLinkBox.style.display = 'none';
  }

  const toolsEl = document.getElementById('esxi-sum-tools');
  if (toolsEl) {
    if (v.hasAgent) {
      toolsEl.textContent = '正在运行 (已连接)';
      toolsEl.style.color = '#22c55e';
    } else if (isRunning) {
      toolsEl.textContent = '未运行 (未安装 qemu-guest-agent)';
      toolsEl.style.color = '#8faec4';
    } else {
      toolsEl.textContent = '未运行';
      toolsEl.style.color = '#8faec4';
    }
  }

  // Hardware tree & Reboot-pending Detection
  const ifacesList = (v.interfaces && v.interfaces.length) ? v.interfaces : [{ type: 'direct', mode: 'bridge', source: 'enp8s0f1' }];
  const liveIfacesList = v.liveInterfaces || [];

  const cpuPending = isRunning && Boolean(v.liveCpu && v.liveCpu !== v.cpu);
  const memPending = isRunning && Boolean(v.liveMemory && v.liveMemory !== v.memory);
  const netPending = isRunning && Boolean(
    liveIfacesList.length !== ifacesList.length ||
    ifacesList.some((ic, idx) => !liveIfacesList[idx] || liveIfacesList[idx].source !== ic.source || liveIfacesList[idx].mode !== ic.mode)
  );
  const hasPendingReboot = cpuPending || memPending || netPending;

  let hwHtml = '';

  // 1. Pending reboot warning banner at top of Hardware Configuration card
  if (hasPendingReboot) {
    const pendingList = [];
    if (cpuPending) pendingList.push(`CPU 核心 (${v.liveCpu} 核 ➔ 新配置 ${v.cpu} 核)`);
    if (memPending) pendingList.push(`内存 (${(v.liveMemory / 1024).toFixed(1)}G ➔ 新配置 ${(v.memory / 1024).toFixed(1)}G)`);
    if (netPending) {
      pendingList.push(`网卡配置 (${liveIfacesList.length} 张运行态网卡 ➔ 新配置 ${ifacesList.length} 张网卡/直通口)`);
    }
    hwHtml += `
      <div style="background:rgba(234,179,8,0.12); border:1px solid rgba(234,179,8,0.45); border-radius:6px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <div>
          <div style="font-size:12.5px; font-weight:700; color:#eab308; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-clock-rotate-left"></i>
            <span>部分硬件配置已修改，需重启后生效</span>
          </div>
          <div style="font-size:11.5px; color:var(--esxi-text-muted); margin-top:3px; line-height:1.5;">
            待生效硬件：<strong style="color:var(--esxi-text);">${escapeHtml(pendingList.join('； '))}</strong>。<br>
            提示：CPU、内存及多网卡独占直通等底层硬件不支持在线热替换，需重启客户机系统加载新配置。
          </div>
        </div>
        <button class="esxi-btn esxi-btn-sm" onclick="esxiVmAction('reboot')" style="background:#eab308; color:#000; font-weight:700; border:none; padding:6px 14px; border-radius:4px; cursor:pointer;">
          <i class="fa-solid fa-rotate-right"></i> 立即重启客户机
        </button>
      </div>
    `;
  }

  // 2. CPU
  const cpuVal = cpuPending
    ? `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span class="ops-tag" style="background:rgba(234,179,8,0.2); color:#eab308; border:1px solid rgba(234,179,8,0.5); font-weight:700; padding:2px 8px;">
          <i class="fa-solid fa-clock-rotate-left"></i> 重启后生效
        </span>
        <strong>新配置: ${v.cpu} vCPU</strong>
        <span style="font-size:11.5px; color:var(--esxi-text-muted);">(当前运行态: ${v.liveCpu} vCPU)</span>
      </div>
    `
    : `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <strong>${v.cpu} vCPU</strong>
        ${isRunning ? '<span class="ops-tag" style="font-size:10px; opacity:0.85;" title="修改需重启虚拟机生效">修改需重启后生效</span>' : ''}
      </div>
    `;

  hwHtml += `
    <div class="esxi-hw-item">
      <span class="esxi-hw-label"><i class="fa-solid fa-microchip" style="color:#0095d9"></i> CPU</span>
      <span class="esxi-hw-val">${cpuVal}</span>
    </div>
  `;

  // 3. Memory
  const memVal = memPending
    ? `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span class="ops-tag" style="background:rgba(234,179,8,0.2); color:#eab308; border:1px solid rgba(234,179,8,0.5); font-weight:700; padding:2px 8px;">
          <i class="fa-solid fa-clock-rotate-left"></i> 重启后生效
        </span>
        <strong>新配置: ${(v.memory / 1024).toFixed(1)} GiB (${v.memory} MiB)</strong>
        <span style="font-size:11.5px; color:var(--esxi-text-muted);">(当前运行态: ${(v.liveMemory / 1024).toFixed(1)} GiB)</span>
      </div>
    `
    : `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <strong>${(v.memory / 1024).toFixed(1)} GiB</strong>
        <span style="font-size:11px; color:var(--esxi-text-muted);">(${v.memory} MiB)</span>
        ${isRunning ? '<span class="ops-tag" style="font-size:10px; opacity:0.85;" title="修改需重启虚拟机生效">修改需重启后生效</span>' : ''}
      </div>
    `;

  hwHtml += `
    <div class="esxi-hw-item">
      <span class="esxi-hw-label"><i class="fa-solid fa-memory" style="color:#a855f7"></i> 内存</span>
      <span class="esxi-hw-val">${memVal}</span>
    </div>
  `;

  // 4. System Disk (Hot-resize supported!)
  const sysDisk = (v.disks || []).find(x => x.device === 'disk' && x.type === 'file');
  if (sysDisk) {
    const dsName = sysDisk.datastore || (sysDisk.path.includes('/mnt/raid10') ? 'datastore-raid10' : (sysDisk.path.includes('/mnt/vadata') ? 'datastore-ssd' : 'datastore1'));
    const sysCap = sysDisk.capacityGiB || v.diskSize || 32;
    hwHtml += `
      <div class="esxi-hw-item">
        <span class="esxi-hw-label"><i class="fa-solid fa-hard-drive" style="color:#38bdf8"></i> 硬盘 1 (系统盘)</span>
        <span class="esxi-hw-val" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <strong>${dsName} · ${sysCap} GiB (QCOW2)</strong>
          <span class="ops-tag good" style="font-size:10.5px;"><i class="fa-solid fa-bolt"></i> 支持在线热扩容 · 立即生效</span>
        </span>
      </div>
    `;
  }

  // 5. Passthrough disks
  const rawDisks = (v.disks || []).filter(x => x.type === 'block' || (x.path && x.path.startsWith('/dev/')));
  rawDisks.forEach((rd, idx) => {
    let label = `硬盘 ${idx + 2} (物理直通)`;
    const capStr = rd.capacityGiB ? `${rd.capacityGiB} GB` : '900 GB';
    const snStr = rd.serial ? ` · S/N: ${rd.serial}` : '';
    hwHtml += `
      <div class="esxi-hw-item">
        <span class="esxi-hw-label"><i class="fa-solid fa-server" style="color:#22c55e"></i> ${label}</span>
        <span class="esxi-hw-val">${rd.target || ('sd' + String.fromCharCode(99+idx))}: ${capStr} SAS${escapeHtml(snStr)}</span>
      </div>
    `;
  });

  // 6. CD/DVD Drive
  const cd = v.disks.find(x => x.device === 'cdrom');
  const cdName = cd?.path ? cd.path.split('/').pop() : '未挂载 (空)';
  hwHtml += `
    <div class="esxi-hw-item">
      <span class="esxi-hw-label"><i class="fa-solid fa-compact-disc" style="color:#f59e0b"></i> CD/DVD 驱动器 1</span>
      <span class="esxi-hw-val" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span>${escapeHtml(cdName)}</span>
        <button class="esxi-btn esxi-btn-sm" onclick="vmChooseMedia('${v.id}')" ${isOff ? '' : 'disabled'} title="挂载或更换 ISO 镜像">挂载</button>
        ${cd?.path ? `<button class="esxi-btn esxi-btn-sm" onclick="esxiVmAction('eject-boot-disk')" ${isOff ? '' : 'disabled'} title="弹出镜像并从硬盘启动">⏏️ 弹出</button>` : ''}
        ${isRunning ? '<span class="ops-tag" style="font-size:10px; opacity:0.8;">弹出/更换需关机或重启</span>' : ''}
      </span>
    </div>
  `;

  // 7. Network Adapter 1
  ifacesList.forEach((iface, idx) => {
    const live = liveIfacesList[idx];
    const active = (isRunning && live) ? live : iface;
    const isPt = active.mode === 'passthrough';
    const isBr = active.mode === 'bridge' || active.type === 'bridge';
    const portName = active.source || 'enp8s0f1';

    let netBadge = '';
    if (isPt) {
      netBadge = `<span class="ops-tag" style="background:rgba(168,85,247,0.2); color:#c084fc; border:1px solid rgba(168,85,247,0.45); font-weight:700;"><i class="fa-solid fa-server"></i> ⚡ 物理网卡独占直通</span>`;
    } else if (isBr) {
      netBadge = `<span class="ops-tag good"><i class="fa-solid fa-network-wired"></i> 🖧 系统共享网口 (局域网同网段桥接)</span>`;
    } else {
      netBadge = `<span class="ops-tag">NAT 内部网络</span>`;
    }

    const ifacePending = isRunning && Boolean(live && (live.source !== iface.source || live.mode !== iface.mode));

    let netStatusHtml = '';
    if (ifacePending) {
      const liveSource = live.source || 'enp8s0f1';
      const liveMode = live.mode === 'passthrough' ? '独占直通' : '共享桥接';
      const newMode = iface.mode === 'passthrough' ? '独占直通' : '共享桥接';
      netStatusHtml = `
        <span class="ops-tag" style="background:rgba(234,179,8,0.2); color:#eab308; border:1px solid rgba(234,179,8,0.5); font-weight:700; padding:2px 8px;">
          <i class="fa-solid fa-clock-rotate-left"></i> 重启后生效
        </span>
        <strong>新配置: <code>${escapeHtml(iface.source || 'enp8s0f1')}</code> (${newMode})</strong>
        <span style="font-size:11.5px; color:var(--esxi-text-muted);">(当前运行态: <code>${escapeHtml(liveSource)}</code> ${liveMode})</span>
      `;
    } else {
      netStatusHtml = `
        <strong>物理端口: <code>${escapeHtml(portName)}</code></strong>
        ${iface.mac ? `<span style="font-size:11px; color:var(--esxi-text-muted); font-family:monospace;">(MAC: ${escapeHtml(iface.mac)})</span>` : ''}
        
        ${isRunning ? '<span class="ops-tag" style="font-size:10px; opacity:0.85;" title="修改网卡需重启虚拟机生效">修改需重启后生效</span>' : ''}
      `;
    }

    const modeTag = isPt 
      ? '<span class="ops-tag" style="background:rgba(168,85,247,0.2);color:#c084fc;font-size:11px;font-weight:600;padding:1px 6px;">直通</span>' 
      : (isBr 
        ? '<span class="ops-tag good" style="font-size:11px;font-weight:600;padding:1px 6px;">桥接</span>' 
        : '<span class="ops-tag" style="font-size:11px;font-weight:600;padding:1px 6px;">NAT</span>');
    const macStr = iface.mac ? `<span style="font-family:monospace;font-size:11px;color:var(--esxi-text-muted);margin-left:4px;">(${escapeHtml(iface.mac)})</span>` : '';

    hwHtml += `
      <div class="esxi-hw-item">
        <span class="esxi-hw-label"><i class="fa-solid fa-network-wired" style="color:#0095d9;"></i> 网络适配器 ${idx + 1}</span>
        <span class="esxi-hw-val">
          ${modeTag}
          <strong style="color:var(--esxi-text);margin-left:4px;">${escapeHtml(portName)}</strong>
          ${macStr}
        </span>
      </div>
    `;
  });

  document.getElementById('esxi-sum-hw-tree').innerHTML = hwHtml;
}

function esxiUpdateToolbarButtons(v) {
  const isRunning = v ? (v.state === 1 || v.state === 2) : false;
  const isPaused = v ? (v.state === 3) : false;
  const isOff = v ? (v.state === 5) : false;
  const hasVm = Boolean(v);

  const btnStart = document.getElementById('esxi-tb-start');
  const btnShutdown = document.getElementById('esxi-tb-shutdown');
  const btnReboot = document.getElementById('esxi-tb-reboot');
  const btnConsole = document.getElementById('esxi-tb-console');
  const btnEject = document.getElementById('esxi-tb-eject');
  const btnNet = document.getElementById('esxi-tb-net');
  const btnBackup = document.getElementById('esxi-tb-backup');
  const btnDelete = document.getElementById('esxi-tb-delete');
  const btnEdit = document.getElementById('esxi-tb-edit');
  const btnClone = document.getElementById('esxi-tb-clone');

  if (btnStart) {
    btnStart.disabled = !hasVm || isRunning;
    if (isPaused) {
      btnStart.innerHTML = '<i class="fa-solid fa-play"></i> 恢复 (Resume)';
      btnStart.title = '恢复挂起的虚拟机运行';
      btnStart.disabled = false;
    } else {
      btnStart.innerHTML = '<i class="fa-solid fa-play"></i> 打开电源';
      btnStart.title = '开启虚拟机电源';
    }
  }
  if (btnShutdown) btnShutdown.disabled = !hasVm || isOff;
  if (btnReboot) btnReboot.disabled = !hasVm || !isRunning;
  if (btnConsole) btnConsole.disabled = !hasVm || isOff;
  if (btnEject) btnEject.disabled = !hasVm || !isOff;
  if (btnNet) btnNet.disabled = !hasVm || !isOff;
  if (btnEdit) btnEdit.disabled = !hasVm;
  if (btnClone) btnClone.disabled = !hasVm || !isOff;
  if (btnBackup) btnBackup.disabled = !hasVm;
  if (btnDelete) {
    btnDelete.disabled = !hasVm;
    btnDelete.title = isOff ? '彻底删除虚拟机及其系统虚拟磁盘' : '强制关机并彻底删除虚拟机及其系统虚拟磁盘';
  }
}

/* ─── VM Actions from Toolbar ─── */
async function esxiVmAction(action) {
  if (!vmSelected) {
    if (vmInventory?.vms?.length) {
      vmSelected = vmInventory.vms[0].id;
    } else {
      alert('请先在表格中选择虚拟机');
      return;
    }
  }
  let v = vmInventory?.vms?.find(x => x.id === vmSelected);
  if (!v && vmInventory?.vms?.length) {
    v = vmInventory.vms[0];
    vmSelected = v.id;
  }
  if (!v) return;

  if (action === 'console') {
    vmConsole(v.id);
  } else if (action === 'start') {
    if (v.state === 3) {
      await vmControl(v.id, 'resume');
    } else {
      await vmControl(v.id, 'start');
    }
  } else if (action === 'shutdown') {
    await vmControl(v.id, 'shutdown');
  } else if (action === 'force-stop') {
    if (!confirm(`确认强制切断虚拟机【${v.name}】的电源？
此操作等同于直接拔掉物理电源线。`)) return;
    await vmControl(v.id, 'force-stop', { confirmation: v.name });
  } else if (action === 'reboot') {
    if (!confirm(`确认重启客户机操作系统【${v.name}】？`)) return;
    await vmControl(v.id, 'reboot');
  } else if (action === 'reset') {
    if (!confirm(`确认强制重置 虚拟机【${v.name}】？
此操作类似按下物理机重启键。`)) return;
    await vmControl(v.id, 'reset');
  } else if (action === 'pause') {
    await vmControl(v.id, 'pause');
  } else if (action === 'resume') {
    await vmControl(v.id, 'resume');
  } else if (action === 'eject-boot-disk') {
    await vmEjectBootDisk(v.id);
  } else if (action === 'network-configure') {
    await vmConfigureNetwork(v.id);
  } else if (action === 'backup-create') {
    await vmBackupCurrentPrompt(v.id);
  } else if (action === 'delete') {
    await vmDelete(v.id);
  }
}

async function vmControl(id, action, extra = {}) {
  if (vmBusy) return;
  vmBusy = true;
  vmMessage('正在执行…');
  try {
    await vmRequest({ id, action, ...extra });
    vmMessage(action === 'shutdown' ? '已发送正常关机请求，等待客户机响应…' : '操作成功');
    vmListSignature = '';
  } catch (e) {
    vmMessage('操作失败：' + e.message);
  } finally {
    vmBusy = false;
    await fetchVMs();
  }
}

/* ─── Eject Boot Disk & Network Configure ─── */
async function vmEjectBootDisk(id) {
  const v = vmInventory?.vms?.find(x => x.id === id);
  if (!v) return;
  if (v.state !== 5) {
    alert(`必须先关闭虚拟机【${v.name}】再弹出安装镜像。\n当前状态：${vmState[v.state] || '运行中'}\n请先点击【关闭电源】。`);
    return;
  }
  if (!confirm(`确认将安装 ISO 镜像从虚拟机【${v.name}】的光驱中弹出？\n\n- 弹出后系统盘将作为第一启动项；\n- 开启电源后将直接进入安装好的系统，不再回到安装引导界面。`)) return;
  await vmControl(id, 'eject-boot-disk');
  vmMessage(`【${v.name}】安装镜像已弹出并设为硬盘启动！点击【打开电源】即可进入系统。`);
}

async function vmConfigureNetwork(id) {
  const v = vmInventory?.vms?.find(x => x.id === id);
  if (!v) return;
  if (v.state !== 5) {
    alert(`修改网卡模式前必须先关闭虚拟机【${v.name}】。\n当前状态：${vmState[v.state] || '运行中'}`);
    return;
  }
  const modeChoice = prompt(
    `为【${v.name}】选择网卡网络模式：\n\n` +
    `1. 局域网同网段桥接 (推荐：桥接 enp8s0f1 · 自动获取 192.168.1.x · 局域网电脑/手机均可直达)\n` +
    `2. 物理网卡独占直通\n` +
    `3. 内部隔离 NAT 网络 (192.168.122.x)\n\n请输入数字 1、2 或 3：`, '1');
  if (!modeChoice) return;
  let networkMode = 'bridge', networkDev = 'enp8s0f1';
  if (modeChoice === '1') {
    networkMode = 'bridge'; networkDev = 'enp8s0f1';
  } else if (modeChoice === '2') {
    networkMode = 'passthrough';
    const devs = vmInventory?.networkInterfaces?.map(i => i.name).join(' / ') || 'enp8s0f1';
    networkDev = prompt(`请输入要直通的物理网卡名称（可选：${devs}）：`, 'enp8s0f1');
    if (!networkDev) return;
  } else if (modeChoice === '3') {
    networkMode = 'nat';
  } else {
    alert('输入无效'); return;
  }
  await vmControl(id, 'network-configure', { networkMode, networkDev });
  vmMessage(`【${v.name}】网卡模式已更新为：${networkMode === 'bridge' ? '局域网同网段桥接 (' + networkDev + ')' : networkMode}`);
}

/* ─── Datastores Management & View ─── */
function esxiRenderDatastores() {
  const d = vmInventory;
  if (!d || !d.datastores) return;
  const tbody = document.getElementById('esxi-datastores-tbody');
  const cardsGrid = document.getElementById('esxi-ds-cards-grid');

  if (tbody) {
    tbody.innerHTML = d.datastores.map(ds => {
      const pct = Math.round((ds.usedGiB / ds.totalGiB) * 100) || 0;
      return `
        <tr>
          <td class="esxi-td-bold"><i class="fa-solid fa-database" style="color:#0095d9;margin-right:8px;"></i>${escapeHtml(ds.name)}</td>
          <td>${escapeHtml(ds.device || '—')}</td>
          <td>${escapeHtml(ds.fsType || 'ext4')}</td>
          <td>${ds.totalGiB} GiB</td>
          <td style="color:#22c55e;font-weight:600;">${ds.freeGiB} GiB</td>
          <td>
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="esxi-progress-bar"><div class="esxi-progress-fill" style="width:${pct}%"></div></div>
              <span style="font-size:12px;">${pct}%</span>
            </div>
          </td>
          <td style="font-family:monospace;font-size:12px;">${escapeHtml(ds.mount)}</td>
          <td>
            <button class="esxi-btn esxi-btn-sm" onclick="esxiOpenDsBrowser('${ds.id}')"><i class="fa-solid fa-folder-open"></i> 浏览文件</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  if (cardsGrid) {
    cardsGrid.innerHTML = d.datastores.map(ds => {
      const pct = Math.round((ds.usedGiB / ds.totalGiB) * 100) || 0;
      return `
        <div class="esxi-card">
          <div class="esxi-card-header">
            <span><i class="fa-solid fa-database" style="color:#0095d9;margin-right:6px;"></i>${escapeHtml(ds.name)}</span>
            <span class="ops-tag">${escapeHtml(ds.type || '本地存储')}</span>
          </div>
          <div class="esxi-card-body">
            <div style="margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                <span>已用 ${ds.usedGiB} GiB / 总计 ${ds.totalGiB} GiB</span>
                <strong style="color:#22c55e;">剩余 ${ds.freeGiB} GiB</strong>
              </div>
              <div class="esxi-progress-bar" style="height:12px;"><div class="esxi-progress-fill" style="width:${pct}%"></div></div>
            </div>
            <div class="esxi-hw-item"><span class="esxi-hw-label">挂载目录</span><span class="esxi-hw-val" style="font-family:monospace;">${escapeHtml(ds.mount)}</span></div>
            <div class="esxi-hw-item"><span class="esxi-hw-label">硬件设备</span><span class="esxi-hw-val">${escapeHtml(ds.device)}</span></div>
            <div style="margin-top:12px;text-align:right;">
              <button class="esxi-btn esxi-btn-primary esxi-btn-sm" onclick="esxiOpenDsBrowser('${ds.id}')"><i class="fa-solid fa-folder-open"></i> 存储浏览器</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

/* ─── Datastore Browser ("存储浏览器") Modal ─── */
function esxiOpenDsBrowser(targetDsId) {
  if (targetDsId) esxiSelectedDatastore = targetDsId;
  const modal = document.getElementById('esxi-ds-browser-modal');
  if (modal) modal.style.display = 'flex';
  esxiRefreshDsBrowser();
}

function esxiCloseDsBrowser() {
  const modal = document.getElementById('esxi-ds-browser-modal');
  if (modal) modal.style.display = 'none';
}

async function esxiRefreshDsBrowser() {
  const d = vmInventory;
  if (!d || !d.datastores) return;

  // Render left datastore list
  const dsList = document.getElementById('esxi-dsb-ds-list');
  if (dsList) {
    dsList.innerHTML = d.datastores.map(ds => `
      <li class="esxi-nav-item ${ds.id === esxiSelectedDatastore ? 'active' : ''}" onclick="esxiSelectDsbDatastore('${ds.id}')">
        <span class="esxi-nav-icon">💽</span>
        <span class="esxi-nav-label">${escapeHtml(ds.name)}</span>
        <span class="esxi-badge">${ds.freeGiB}G</span>
      </li>
    `).join('');
  }

  // Update title
  const curDs = d.datastores.find(x => x.id === esxiSelectedDatastore) || d.datastores[0];
  if (curDs) {
    document.getElementById('esxi-dsb-title').textContent = `${curDs.name} (${curDs.mount})`;
    document.getElementById('esxi-dsb-footer-info').textContent = `数据存储: ${curDs.name} · 可用空间: ${curDs.freeGiB} GiB / 总计 ${curDs.totalGiB} GiB`;
  }

  // Fetch files in datastore
  const filesBody = document.getElementById('esxi-dsb-files-body');
  filesBody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#8faec4;">正在扫描文件…</td></tr>`;

  try {
    const res = await vmRequest({ action: 'datastore-browse', datastoreId: esxiSelectedDatastore });
    const files = res.files || [];
    if (!files.length) {
      filesBody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#8faec4;">当前数据存储暂无 ISO 镜像或虚拟机磁盘。点击上方【上传 ISO / 文件】上传。</td></tr>`;
      return;
    }

    filesBody.innerHTML = files.map(f => {
      let icon = 'fa-file';
      const low = f.name.toLowerCase();
      if (low.endsWith('.iso')) icon = 'fa-compact-disc';
      else if (low.endsWith('.img') || low.endsWith('.raw')) icon = 'fa-microchip';
      else if (low.endsWith('.qcow2') || low.endsWith('.vmdk')) icon = 'fa-hard-drive';
      else if (low.endsWith('.gz')) icon = 'fa-file-zipper';

      const canDelete = f.folder === 'iso' || low.endsWith('.iso') || low.endsWith('.img') || low.endsWith('.raw') || low.endsWith('.vmdk');

      return `
        <tr>
          <td><i class="fa-solid ${icon}" style="color:#0095d9;margin-right:8px;"></i>${escapeHtml(f.name)}</td>
          <td>${vmSize(f.size)}</td>
          <td><span class="ops-tag">${escapeHtml(f.type || '文件')}</span></td>
          <td>${new Date(f.mtime * 1000).toLocaleString()}</td>
          <td>
            ${canDelete ? `<button class="esxi-btn esxi-btn-danger esxi-btn-sm" onclick="esxiDsbDeleteIso('${escapeHtml(f.name)}')"><i class="fa-solid fa-trash"></i> 删除</button>` : '—'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    filesBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:20px;">读取失败：${escapeHtml(e.message)}</td></tr>`;
  }
}

function esxiSelectDsbDatastore(dsId) {
  esxiSelectedDatastore = dsId;
  esxiRefreshDsBrowser();
}

async function esxiDsbDeleteIso(name) {
  if (!confirm(`确认永久删除镜像/固件文件：${name}？\n此操作将释放数据存储空间。`)) return;
  try {
    await vmControl(null, 'iso-delete', { name, confirmation: name });
    await fetchVMs();
    await esxiRefreshDsBrowser();
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

/* ─── Upload ISO / Firmware to Selected Datastore ─── */
async function esxiHandleDsbUpload(event) {
  const f = event.target.files[0];
  if (!f) return;
  const low = f.name.toLowerCase();
  const valid = ['.iso', '.img', '.gz', '.qcow2', '.vmdk', '.raw'];
  if (!valid.some(ext => low.endsWith(ext))) {
    alert('仅支持上传系统安装与固件镜像：.iso, .img, .img.gz, .gz, .qcow2, .vmdk');
    event.target.value = '';
    return;
  }
  const isGz = low.endsWith('.gz');
  const progress = document.getElementById('esxi-dsb-progress');
  const status = document.getElementById('esxi-dsb-upload-status');
  progress.style.display = 'block';
  progress.value = 0;
  status.textContent = `准备上传 ${f.name} 到 ${esxiSelectedDatastore}…`;

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/vms/iso?name=${encodeURIComponent(f.name)}&datastoreId=${encodeURIComponent(esxiSelectedDatastore)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (typeof clientAuthToken !== 'undefined' && clientAuthToken) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + clientAuthToken);
      }
      xhr.upload.onprogress = e => {
        const pct = e.lengthComputable ? Math.round(e.loaded / e.total * 100) : 0;
        progress.value = pct;
        status.textContent = isGz 
          ? `上传中 ${pct}% (${vmSize(e.loaded)} / ${vmSize(f.size)}) · 服务器将自动解压固件…`
          : `上传中 ${pct}% (${vmSize(e.loaded)} / ${vmSize(f.size)})`;
      };
      xhr.onload = () => {
        try {
          const j = JSON.parse(xhr.responseText);
          j.success ? resolve(j) : reject(Error(j.error));
        } catch (err) { reject(err); }
      };
      xhr.onerror = () => reject(Error('网络连接失败'));
      xhr.send(f);
    });

    status.textContent = isGz 
      ? `${f.name} 上传成功！已自动完成固件解压并就绪于 ${esxiSelectedDatastore}`
      : `${f.name} 上传成功！已保存到 ${esxiSelectedDatastore}`;
    event.target.value = '';
    await fetchVMs();
    await esxiRefreshDsBrowser();
  } catch (e) {
    status.textContent = '上传失败：' + e.message;
    alert('上传未完成：' + e.message);
  } finally {
    setTimeout(() => { progress.style.display = 'none'; }, 4000);
  }
}

/* ─── Host Overview & Networking Views ─── */
function esxiRenderHostOverview() {
  const d = vmInventory;
  if (!d) return;
  const cpuVal = document.getElementById('esxi-host-cpu-val');
  if (cpuVal) cpuVal.textContent = `${d.cpus} vCPUs · Intel Xeon E5-2650 v2 @ 2.60GHz`;
  const memVal = document.getElementById('esxi-host-mem-val');
  if (memVal) memVal.textContent = `${(d.memoryMiB / 1024).toFixed(1)} GiB 物理内存`;

  const dsSum = document.getElementById('esxi-host-ds-summary');
  if (dsSum && d.datastores) {
    dsSum.innerHTML = d.datastores.map(ds => {
      const pct = Math.round((ds.usedGiB / ds.totalGiB) * 100) || 0;
      return `
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
            <strong>${escapeHtml(ds.name)}</strong>
            <span>剩余 ${ds.freeGiB} GiB / ${ds.totalGiB} GiB (${pct}%)</span>
          </div>
          <div class="esxi-progress-bar"><div class="esxi-progress-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    }).join('');
  }
}

function esxiRenderNetworking() {
  const d = vmInventory;
  if (!d || !d.networkInterfaces) return;
  const nicsBody = document.getElementById('esxi-nics-body');
  if (nicsBody) {
    nicsBody.innerHTML = d.networkInterfaces.map(n => `
      <div class="esxi-hw-item">
        <span class="esxi-hw-label">
          <i class="fa-solid fa-network-wired" style="color:${n.up ? '#22c55e' : '#64748b'}"></i>
          <strong>${escapeHtml(n.name)}</strong>
          ${n.isDefault ? '<span class="ops-tag good">主管理接口</span>' : ''}
        </span>
        <span class="esxi-hw-val">${escapeHtml(n.desc)}</span>
      </div>
    `).join('');
  }
}

/* ─── Multi-NIC State & Management ─── */
let vmCreateNics = [
  { mode: 'bridge', dev: 'enp8s0f1', role: '管理网口 (LAN)' }
];
let vmEditNics = [];

function vmApplyRouterTemplate() {
  const allDevs = (vmInventory?.networkInterfaces || []).map(x => x.name);
  const mgmtDev = (vmInventory?.networkInterfaces || []).find(x => x.isDefault)?.name || 'enp8s0f1';
  const nonMgmtDevs = allDevs.filter(x => x !== mgmtDev);

  vmCreateNics = [
    { mode: 'bridge', dev: mgmtDev, role: '管理网口 (LAN)' },
    { mode: 'passthrough', dev: nonMgmtDevs[0] || 'enp5s0f0', role: 'WAN 口 (直通)' },
    { mode: 'passthrough', dev: nonMgmtDevs[1] || 'enp5s0f1', role: 'LAN 口 (直通)' }
  ];
  vmRenderCreateNics();
}

function esxiApplyRouterTemplateEdit() {
  const allDevs = (vmInventory?.networkInterfaces || []).map(x => x.name);
  const mgmtDev = (vmInventory?.networkInterfaces || []).find(x => x.isDefault)?.name || 'enp8s0f1';
  const nonMgmtDevs = allDevs.filter(x => x !== mgmtDev);

  vmEditNics = [
    { mode: 'bridge', dev: mgmtDev, role: '管理网口 (LAN)' },
    { mode: 'passthrough', dev: nonMgmtDevs[0] || 'enp5s0f0', role: 'WAN 口 (直通)' },
    { mode: 'passthrough', dev: nonMgmtDevs[1] || 'enp5s0f1', role: 'LAN 口 (直通)' }
  ];
  esxiRenderEditNics();
}

function vmRenderCreateNics() {
  const container = document.getElementById('vm-new-nics-container');
  if (!container) return;
  const devOptions = (vmInventory?.networkInterfaces || []).map(n => {
    return `<option value="${escapeHtml(n.name)}">${escapeHtml(n.desc)}</option>`;
  }).join('');

  container.innerHTML = vmCreateNics.map((nic, idx) => {
    const isPt = nic.mode === 'passthrough';
    const isBr = nic.mode === 'bridge';
    const isMgmt = (vmInventory?.networkInterfaces || []).find(x => x.name === nic.dev)?.isDefault;
    const warnMgmt = isPt && isMgmt;

    let roleBadge = '';
    if (nic.role) {
      roleBadge = `<span class="ops-tag" style="background:rgba(234,179,8,0.18); color:#eab308; border:1px solid rgba(234,179,8,0.35); font-size:10px; padding:1px 6px;">${escapeHtml(nic.role)}</span>`;
    }

    return `
      <div style="background:var(--esxi-bg-row-alt); border:1px solid ${warnMgmt ? '#ef4444' : (isPt ? '#a855f7' : 'var(--esxi-border)')}; border-radius:6px; padding:10px 14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <strong style="color:var(--esxi-text); font-size:12px;">
              <i class="fa-solid fa-network-wired" style="color:${isPt ? '#c084fc' : '#38bdf8'}; margin-right:4px;"></i>
              网络适配器 ${idx + 1}
            </strong>
            ${isPt ? '<span class="ops-tag" style="background:rgba(168,85,247,0.2); color:#c084fc; border:1px solid rgba(168,85,247,0.45); font-size:10px;">独占直通</span>' : (isBr ? '<span class="ops-tag good" style="font-size:10px;">局域网桥接</span>' : '<span class="ops-tag" style="font-size:10px;">内部 NAT</span>')}
            ${roleBadge}
          </div>
          ${vmCreateNics.length > 1 ? `<button type="button" class="btn-icon" onclick="vmRemoveCreateNicRow(${idx})" title="删除此网卡" style="color:#ef4444;"><i class="fa-solid fa-trash"></i></button>` : ''}
        </div>
        <div class="vm-form-grid" style="grid-template-columns:1fr 1.3fr; gap:10px;">
          <label style="margin:0;">工作模式
            <select class="form-input" onchange="vmOnCreateNicChange(${idx}, 'mode', this.value)">
              <option value="bridge" ${isBr ? 'selected' : ''}>局域网桥接 (Bridge)</option>
              <option value="passthrough" ${isPt ? 'selected' : ''}>物理网卡独占直通 (Passthrough)</option>
              <option value="nat" ${nic.mode === 'nat' ? 'selected' : ''}>内部 NAT 网络 (virbr0)</option>
            </select>
          </label>
          <label style="margin:0; ${nic.mode === 'nat' ? 'display:none;' : ''}">物理网卡接口
            <select class="form-input" onchange="vmOnCreateNicChange(${idx}, 'dev', this.value)">
              ${devOptions}
            </select>
          </label>
        </div>
        ${warnMgmt ? '<div style="color:#ef4444; font-size:11px; margin-top:6px; font-weight:600;"><i class="fa-solid fa-triangle-exclamation"></i> 警告：当前选中的是宿主机主管理口，严禁设为独占直通，否则宿主机将断网！请更换为其他独立端口。</div>' : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.vm-form-grid').forEach((grid, idx) => {
    const selects = grid.querySelectorAll('select');
    if (selects[1] && vmCreateNics[idx].dev) selects[1].value = vmCreateNics[idx].dev;
  });

  const tip = document.getElementById('vm-new-net-tip');
  if (tip) {
    const hasPt = vmCreateNics.some(x => x.mode === 'passthrough');
    const hasBr = vmCreateNics.some(x => x.mode === 'bridge');
    tip.innerHTML = `
      <div style="background:rgba(0,149,217,0.08); border:1px solid rgba(0,149,217,0.25); border-radius:6px; padding:10px 12px; font-size:11.5px; color:var(--esxi-text-muted); line-height:1.6;">
        • 当前共配置 <b>${vmCreateNics.length} 个网络适配器</b>。
      </div>
    `;
  }
}

function vmAddCreateNicRow() {
  const allDevs = (vmInventory?.networkInterfaces || []).map(x => x.name);
  const mgmtDev = (vmInventory?.networkInterfaces || []).find(x => x.isDefault)?.name || 'enp8s0f1';
  const usedDevs = vmCreateNics.map(x => x.dev);
  const nextDev = allDevs.find(x => x !== mgmtDev && !usedDevs.includes(x)) || allDevs.find(x => x !== mgmtDev) || allDevs[0];
  vmCreateNics.push({ mode: 'passthrough', dev: nextDev });
  vmRenderCreateNics();
}

function vmRemoveCreateNicRow(idx) {
  if (vmCreateNics.length <= 1) return;
  vmCreateNics.splice(idx, 1);
  vmRenderCreateNics();
}

function vmOnCreateNicChange(idx, field, val) {
  if (!vmCreateNics[idx]) return;
  vmCreateNics[idx][field] = val;
  delete vmCreateNics[idx].role;
  vmRenderCreateNics();
}

function esxiRenderEditNics() {
  const container = document.getElementById('esxi-edit-nics-container');
  if (!container) return;
  const devOptions = (vmInventory?.networkInterfaces || []).map(n => {
    return `<option value="${escapeHtml(n.name)}">${escapeHtml(n.desc)}</option>`;
  }).join('');

  container.innerHTML = vmEditNics.map((nic, idx) => {
    const isPt = nic.mode === 'passthrough';
    const isBr = nic.mode === 'bridge';
    const isMgmt = (vmInventory?.networkInterfaces || []).find(x => x.name === nic.dev)?.isDefault;
    const warnMgmt = isPt && isMgmt;

    let roleBadge = '';
    if (nic.role) {
      roleBadge = `<span class="ops-tag" style="background:rgba(234,179,8,0.18); color:#eab308; border:1px solid rgba(234,179,8,0.35); font-size:10px; padding:1px 6px;">${escapeHtml(nic.role)}</span>`;
    }

    return `
      <div style="background:var(--esxi-bg-row-alt); border:1px solid ${warnMgmt ? '#ef4444' : (isPt ? '#a855f7' : 'var(--esxi-border)')}; border-radius:6px; padding:10px 14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <strong style="color:var(--esxi-text); font-size:12px;">
              <i class="fa-solid fa-network-wired" style="color:${isPt ? '#c084fc' : '#38bdf8'}; margin-right:4px;"></i>
              网络适配器 ${idx + 1}
            </strong>
            ${isPt ? '<span class="ops-tag" style="background:rgba(168,85,247,0.2); color:#c084fc; border:1px solid rgba(168,85,247,0.45); font-size:10px;">独占直通</span>' : (isBr ? '<span class="ops-tag good" style="font-size:10px;">局域网桥接</span>' : '<span class="ops-tag" style="font-size:10px;">内部 NAT</span>')}
            ${roleBadge}
            ${nic.mac ? `<span style="font-size:11px; color:var(--esxi-text-muted); font-family:monospace;">${escapeHtml(nic.mac)}</span>` : ''}
          </div>
          ${vmEditNics.length > 1 ? `<button type="button" class="btn-icon" onclick="esxiRemoveEditNicRow(${idx})" title="删除此网卡" style="color:#ef4444;"><i class="fa-solid fa-trash"></i></button>` : ''}
        </div>
        <div class="vm-form-grid" style="grid-template-columns:1fr 1.3fr; gap:10px;">
          <label style="margin:0;">工作模式
            <select class="form-input" onchange="esxiOnEditNicChange(${idx}, 'mode', this.value)">
              <option value="bridge" ${isBr ? 'selected' : ''}>局域网桥接 (Bridge)</option>
              <option value="passthrough" ${isPt ? 'selected' : ''}>物理网卡独占直通 (Passthrough)</option>
              <option value="nat" ${nic.mode === 'nat' ? 'selected' : ''}>内部 NAT 网络 (virbr0)</option>
            </select>
          </label>
          <label style="margin:0; ${nic.mode === 'nat' ? 'display:none;' : ''}">物理网卡接口
            <select class="form-input" onchange="esxiOnEditNicChange(${idx}, 'dev', this.value)">
              ${devOptions}
            </select>
          </label>
        </div>
        ${warnMgmt ? '<div style="color:#ef4444; font-size:11px; margin-top:6px; font-weight:600;"><i class="fa-solid fa-triangle-exclamation"></i> 警告：当前选中的是宿主机主管理口，严禁设为独占直通，否则宿主机将断网！请更换为其他独立端口。</div>' : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.vm-form-grid').forEach((grid, idx) => {
    const selects = grid.querySelectorAll('select');
    if (selects[1] && vmEditNics[idx].dev) selects[1].value = vmEditNics[idx].dev;
  });

  const tip = document.getElementById('esxi-edit-net-tip');
  if (tip) {
    tip.innerHTML = `
      <div style="background:rgba(234,179,8,0.12); border:1px solid rgba(234,179,8,0.35); border-radius:6px; padding:10px 12px; font-size:11.5px; color:var(--esxi-text-muted); line-height:1.6;">
        <span style="font-weight:700; color:#eab308;"><i class="fa-solid fa-clock-rotate-left"></i> 修改网卡将在客户机系统重启后生效</span><br>
        当前配置共 <b>${vmEditNics.length} 个网络接口</b>。您可以继续添加物理网卡直通，各接口将自动保持万兆线速同步。
      </div>
    `;
  }
}

function esxiAddEditNicRow() {
  const allDevs = (vmInventory?.networkInterfaces || []).map(x => x.name);
  const mgmtDev = (vmInventory?.networkInterfaces || []).find(x => x.isDefault)?.name || 'enp8s0f1';
  const usedDevs = vmEditNics.map(x => x.dev);
  const nextDev = allDevs.find(x => x !== mgmtDev && !usedDevs.includes(x)) || allDevs.find(x => x !== mgmtDev) || allDevs[0];
  vmEditNics.push({ mode: 'passthrough', dev: nextDev });
  esxiRenderEditNics();
}

function esxiRemoveEditNicRow(idx) {
  if (vmEditNics.length <= 1) return;
  vmEditNics.splice(idx, 1);
  esxiRenderEditNics();
}

function esxiOnEditNicChange(idx, field, val) {
  if (!vmEditNics[idx]) return;
  vmEditNics[idx][field] = val;
  delete vmEditNics[idx].role;
  esxiRenderEditNics();
}

/* ─── VM Creation Wizard ─── */
function esxiOpenCreateModal() {
  const modal = document.getElementById('esxi-create-vm-modal');
  if (modal) modal.style.display = 'flex';
  const mgmtDev = (vmInventory?.networkInterfaces || []).find(x => x.isDefault)?.name || 'enp8s0f1';
  if (!vmCreateNics || !vmCreateNics.length) {
    vmCreateNics = [
      { mode: 'bridge', dev: mgmtDev, role: '管理网口 (LAN)' }
    ];
  }
  vmOnInstallModeChange();
  vmRenderCreateNics();
}
function vmOnInstallModeChange() {
  const mode = document.getElementById('vm-new-install-mode')?.value || 'firmware';
  const fwWrap = document.getElementById('vm-new-firmware-wrap');
  const isoWrap = document.getElementById('vm-new-iso-wrap');
  const fwTip = document.getElementById('vm-new-firmware-tip');
  const diskInput = document.getElementById('vm-new-disk');

  if (mode === 'firmware') {
    if (fwWrap) fwWrap.style.display = '';
    if (isoWrap) isoWrap.style.display = 'none';
    if (fwTip) fwTip.style.display = '';
    if (diskInput && Number(diskInput.value) > 20) diskInput.value = 16;
  } else if (mode === 'iso') {
    if (fwWrap) fwWrap.style.display = 'none';
    if (isoWrap) isoWrap.style.display = '';
    if (fwTip) fwTip.style.display = 'none';
    if (diskInput && Number(diskInput.value) < 32) diskInput.value = 32;
  } else {
    if (fwWrap) fwWrap.style.display = 'none';
    if (isoWrap) isoWrap.style.display = 'none';
    if (fwTip) fwTip.style.display = 'none';
  }
}
function esxiCloseCreateModal() {
  const modal = document.getElementById('esxi-create-vm-modal');
  if (modal) modal.style.display = 'none';
}
function getNetModeTipHtml(mode) {
  return '';
}

function vmOnNetModeChange() {
  const mode = document.getElementById('vm-new-net-mode').value;
  const wrap = document.getElementById('vm-new-net-dev-wrap');
  if (wrap) wrap.style.display = (mode === 'nat' ? 'none' : '');
  const tip = document.getElementById('vm-new-net-tip');
  if (tip) tip.innerHTML = getNetModeTipHtml(mode);
}
async function esxiSubmitCreateVm(event) {
  event.preventDefault();
  if (vmBusy) return;
  vmBusy = true;
  const btn = document.getElementById('vm-create-button');
  btn.disabled = true;
  try {
    const installMode = document.getElementById('vm-new-install-mode')?.value || 'firmware';
    const payload = {
      action: 'create',
      name: document.getElementById('vm-new-name').value.trim(),
      datastoreId: document.getElementById('vm-new-datastore').value,
      cpu: Number(document.getElementById('vm-new-cpu').value),
      memory: Number(document.getElementById('vm-new-ram').value),
      disk: Number(document.getElementById('vm-new-disk').value),
      installMode: installMode,
      firmwareBoot: document.getElementById('vm-new-firmware-boot')?.value || 'bios',
      networkMode: document.getElementById('vm-new-net-mode').value,
      networkDev: document.getElementById('vm-new-net-dev').value
    };

    if (installMode === 'firmware') {
      const fw = document.getElementById('vm-new-firmware')?.value;
      if (!fw) {
        throw Error('请选择有效的固件母盘镜像（若尚未上传，请先在存储浏览器中上传 iStoreOS 固件）');
      }
      payload.firmware = fw;
    } else if (installMode === 'iso') {
      payload.iso = document.getElementById('vm-new-iso')?.value || '';
    }

    for (const nic of vmCreateNics) {
      if (nic.mode === 'passthrough') {
        const isMgmt = (vmInventory?.networkInterfaces || []).find(x => x.name === nic.dev)?.isDefault;
        if (isMgmt) {
          throw Error(`严禁将宿主机主管理口【${nic.dev}】设为独占直通，否则宿主机将失去网络连接！请更换为其他物理网口。`);
        }
      }
    }
    payload.interfaces = vmCreateNics.map(x => ({ mode: x.mode, dev: x.dev }));

    const v = await vmRequest(payload);
    vmMessage(`虚拟机【${v.name}】已成功创建！系统盘部署在 ${payload.datastoreId}`);
    esxiCloseCreateModal();
    await fetchVMs();
    esxiSelectVm(v.id);
  } catch (e) {
    alert('创建失败：' + e.message);
  } finally {
    vmBusy = false;
    btn.disabled = false;
  }
}

/* ─── Delete VM ─── */
async function vmDelete(id) {
  const v = vmInventory?.vms?.find(v => v.id === id);
  if (!v) return;

  const isActive = (v.state !== 5);
  let promptMsg = `⚠️ 永久删除虚拟机【${v.name}】及其系统虚拟磁盘！
此操作将不可逆地彻底销毁该虚拟机及其虚拟磁盘。
`;
  if (isActive) {
    promptMsg += `
【警告】该虚拟机当前正处于${vmState[v.state] || '运行/挂起'}状态，确认删除将自动强制切断电源并立即删除！
`;
  }
  promptMsg += `
请输入虚拟机名称确认删除：${v.name}`;

  const confirmation = prompt(promptMsg);
  if (confirmation !== v.name) {
    if (confirmation !== null) vmMessage('输入的虚拟机名称不匹配，删除已取消');
    return;
  }

  await vmControl(id, 'delete', { confirmation, force: true });
  if (vmSelected === id) vmSelected = null;
  vmListSignature = '';
}

/* ─── Media Dialog (Mount/Change ISO) ─── */
function vmChooseMedia(id, iso) {
  const dialog = document.getElementById('vm-media-dialog');
  const target = document.getElementById('vm-mount-target');
  const source = document.getElementById('vm-mount-iso');
  target.replaceChildren();
  for (const v of vmInventory.vms.filter(v => v.state === 5)) {
    const o = new Option(v.name, v.id);
    target.add(o);
  }
  source.replaceChildren(new Option('不挂载镜像（卸载）', ''));
  for (const i of vmInventory.isos) {
    const dsBadge = i.datastore ? `[${i.datastore}] ` : '';
    source.add(new Option(`${dsBadge}${i.name}`, i.name));
  }
  if (id) target.value = id;
  else if (vmSelected && [...target.options].some(o => o.value === vmSelected)) target.value = vmSelected;

  const update = () => {
    const v = vmInventory.vms.find(v => v.id === target.value);
    source.value = v?.disks.find(x => x.device === 'cdrom')?.path.split('/').pop() || '';
  };
  update();
  target.onchange = () => { if (!iso) update(); };
  if (iso) source.value = iso;
  document.getElementById('vm-mount-submit').disabled = !target.options.length;
  dialog.showModal();
}
async function vmMountSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('vm-mount-target').value;
  const iso = document.getElementById('vm-mount-iso').value;
  if (!id) return;
  document.getElementById('vm-media-dialog').close();
  await vmControl(id, 'media', { iso });
}

/* ─── Console via noVNC ─── */
let vmCurrentConsoleId = null;

function vmConsole(id) {
  if (!id) {
    if (vmSelected) id = vmSelected;
    else if (vmInventory?.vms?.length) id = vmInventory.vms[0].id;
    else return alert('请先在列表中选择虚拟机');
  }
  vmCurrentConsoleId = id;
  const v = vmInventory?.vms?.find(x => x.id === id);
  const name = v ? v.name : id;
  const url = '/vm-console.html?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name);

  console.log('[VM Console] Opening console for:', name, id, url);

  // Open dedicated standalone application window (ESXi style)
  const safeWindowName = 'vm_console_' + String(id).replace(/[^a-zA-Z0-9]/g, '_');
  const w = window.open(url, safeWindowName, 'width=1024,height=768,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
  if (!w || w.closed || typeof w.closed === 'undefined') {
    // If popup blocked, open in regular new tab
    window.open(url, '_blank');
  }
}

function vmReconnectConsole() {
  if (vmCurrentConsoleId) vmConsole(vmCurrentConsoleId);
}

function vmCloseConsole() {
  const modal = document.getElementById('vm-console-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('hidden', '');
  }
  const screenEl = document.getElementById('vm-console-screen');
  if (screenEl) screenEl.innerHTML = '';
}

/* ─── VM Backup & Version Management ─── */
function vmShowBackupNotice(msg, type='info') {
  const el = document.getElementById('vm-backup-notice');
  if (!el) return;
  const isGood = type === 'good' || type === 'success';
  const isErr = type === 'error' || type === 'danger';
  const isLoad = type === 'loading';
  el.style.display = 'block';
  el.style.background = isErr ? 'rgba(239,68,68,0.15)' : (isGood ? 'rgba(16,185,129,0.15)' : 'rgba(0,149,217,0.15)');
  el.style.border = `1px solid ${isErr ? 'rgba(239,68,68,0.4)' : (isGood ? 'rgba(16,185,129,0.4)' : 'rgba(0,149,217,0.4)')}`;
  el.style.color = isErr ? '#ef4444' : (isGood ? '#10b981' : '#0095d9');
  const icon = isLoad ? 'fa-spinner fa-spin' : (isErr ? 'fa-triangle-exclamation' : (isGood ? 'fa-circle-check' : 'fa-circle-info'));
  el.innerHTML = `<i class="fa-solid ${icon}" style="margin-right:8px;"></i>${escapeHtml(msg)}`;
  if (!isErr && !isLoad) {
    setTimeout(() => {
      if (el.textContent.includes(msg)) el.style.display = 'none';
    }, 6000);
  }
}

let vmScheduleFormDirty = false;
let vmScheduleEventsBound = false;
function vmBindScheduleDirtyEvents() {
  if (vmScheduleEventsBound) return;
  const fieldIds = ['vm-sched-enabled', 'vm-sched-time', 'vm-sched-retention', 'vm-sched-target', 'vm-sched-vm'];
  let count = 0;
  fieldIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => { vmScheduleFormDirty = true; });
      el.addEventListener('input', () => { vmScheduleFormDirty = true; });
      count++;
    }
  });
  if (count === fieldIds.length) vmScheduleEventsBound = true;
}

async function vmFetchBackups(forceReset = false) {
  try {
    const targetSelect = document.getElementById('vm-sched-target');
    const targetDir = targetSelect?.value || '';
    const r = await apiFetch('/api/vms/backups' + (targetDir ? '?targetDir=' + encodeURIComponent(targetDir) : ''));
    const j = await r.json();
    if (!j.success) throw Error(j.error);
    vmBackupsData = j.data;
    vmRenderBackupUI(j.data, forceReset);
  } catch (e) {
    vmShowBackupNotice('读取备份列表失败：' + e.message, 'error');
  }
}

function vmRenderBackupUI(data, forceReset = false) {
  vmBindScheduleDirtyEvents();
  const { backups, storageTargets, schedule, freeGiB, targetDir } = data;
  const targetSelect = document.getElementById('vm-sched-target');
  if (storageTargets && storageTargets.length) {
    const currentVal = (!vmScheduleFormDirty || forceReset) ? (schedule.targetDir || storageTargets[0].path) : targetSelect.value;
    targetSelect.innerHTML = storageTargets.map(t =>
      `<option value="${escapeHtml(t.path)}" ${t.path === currentVal ? 'selected' : ''}>${escapeHtml(t.name)} (${t.mount}) · 剩余 ${t.freeGiB} GiB</option>`
    ).join('');
    if (!storageTargets.some(t => t.path === currentVal) && currentVal) {
      targetSelect.innerHTML += `<option value="${escapeHtml(currentVal)}" selected>自定义目录: ${escapeHtml(currentVal)}</option>`;
    }
    targetSelect.value = currentVal;
  }
  const schedVmSelect = document.getElementById('vm-sched-vm');
  const filterVmSelect = document.getElementById('vm-backup-filter');
  const vms = vmInventory?.vms || [];
  if (filterVmSelect) {
    const filterVal = filterVmSelect.value;
    filterVmSelect.innerHTML = '<option value="">全部虚拟机</option>' + vms.map(v =>
      `<option value="${escapeHtml(v.id)}" ${v.id === filterVal ? 'selected' : ''}>${escapeHtml(v.name)}</option>`
    ).join('');
    if (filterVal) filterVmSelect.value = filterVal;
  }
  if (schedVmSelect) {
    const schedVal = (!vmScheduleFormDirty || forceReset) ? (schedule.targetVm || 'all') : schedVmSelect.value;
    schedVmSelect.innerHTML = '<option value="all">全部虚拟机</option>' + vms.map(v =>
      `<option value="${escapeHtml(v.id)}" ${v.id === schedVal ? 'selected' : ''}>${escapeHtml(v.name)}</option>`
    ).join('');
    schedVmSelect.value = schedVal;
  }
  if (!vmScheduleFormDirty || forceReset) {
    const enSelect = document.getElementById('vm-sched-enabled');
    if (enSelect) {
      enSelect.value = String(schedule.enabled);
      enSelect.style.borderColor = schedule.enabled ? '#10b981' : '#ef4444';
    }
    const timeInput = document.getElementById('vm-sched-time');
    if (timeInput) timeInput.value = schedule.time || '05:00';
    const retSelect = document.getElementById('vm-sched-retention');
    if (retSelect) retSelect.value = String(schedule.retentionDays || 7);
  }

  // Update live status badge in card header
  const headerBadge = document.getElementById('vm-sched-header-badge');
  if (headerBadge) {
    if (schedule.enabled) {
      headerBadge.innerHTML = `<span style="font-size:12px;background:rgba(16,185,129,0.18);color:#10b981;padding:2px 8px;border-radius:4px;border:1px solid rgba(16,185,129,0.35);font-weight:600;"><i class="fa-solid fa-circle-check"></i> 自动运行中 (每日 ${escapeHtml(schedule.time || '04:00')})</span>`;
    } else {
      headerBadge.innerHTML = `<span style="font-size:12px;background:rgba(239,68,68,0.18);color:#ef4444;padding:2px 8px;border-radius:4px;border:1px solid rgba(239,68,68,0.35);font-weight:600;"><i class="fa-solid fa-pause"></i> 自动备份已暂停 (未开启)</span>`;
    }
  }

  const spaceEl = document.getElementById('vm-backup-space');
  if (spaceEl) spaceEl.textContent = `目标位置: ${targetDir} (剩余 ${freeGiB} GiB)`;
  vmFilterBackups();
}

function vmFilterBackups() {
  if (!vmBackupsData) return;
  const filterId = document.getElementById('vm-backup-filter')?.value || '';
  const list = document.getElementById('vm-backup-list');
  if (!list) return;
  const items = filterId ? (vmBackupsData.backups || []).filter(b => b.vmId === filterId || b.vmName === filterId) : (vmBackupsData.backups || []);
  if (!items.length) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:#8faec4;">暂无备份镜像版本。点击上方【立即热备系统盘】即可为虚拟机创建镜像备份。</div>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'esxi-table';
  table.innerHTML = '<thead><tr><th>虚拟机</th><th>备份时间</th><th>镜像文件名</th><th>实际大小</th><th>类型</th><th>备注说明</th><th>操作</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const b of items) {
    const row = document.createElement('tr');
    const dStr = b.createdAt ? new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false }) : '未知';
    const typeTag = b.type === 'scheduled' ? '<span class="ops-tag">定时 05:00</span>' : '<span class="ops-tag good">手动热备</span>';
    const noteText = b.note ? escapeHtml(b.note) : '<span style="color:var(--esxi-text-muted);font-size:11px;">—</span>';
    row.innerHTML = `
      <td><strong>${escapeHtml(b.vmName)}</strong></td>
      <td>${escapeHtml(dStr)}</td>
      <td style="font-family:monospace;font-size:12px">${escapeHtml(b.filename)}</td>
      <td>${vmSize(b.size)}</td>
      <td>${typeTag}</td>
      <td style="font-size:12px;">${noteText}</td>
      <td></td>
    `;
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'esxi-btn esxi-btn-sm';
    restoreBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> 恢复系统盘';
    restoreBtn.onclick = () => vmRestoreBackup(b.vmId, b.vmName, b.filename, b.targetDir);

    const delBtn = document.createElement('button');
    delBtn.className = 'esxi-btn esxi-btn-danger esxi-btn-sm';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i> 删除';
    delBtn.style.marginLeft = '6px';
    delBtn.onclick = () => vmDeleteBackup(b.filename, b.targetDir);

    const actionTd = row.lastElementChild || row.querySelector('td:last-child');
    if (actionTd) {
      actionTd.appendChild(restoreBtn);
      actionTd.appendChild(delBtn);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  list.innerHTML = '';
  list.appendChild(table);
}

async function vmSaveSchedule(event) {
  event.preventDefault();
  const btn = document.getElementById('vm-sched-submit-btn');
  const status = document.getElementById('vm-sched-status');
  if (btn) btn.disabled = true;
  if (status) {
    status.style.color = '#0095d9';
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px;"></i>正在保存…';
  }
  try {
    const body = {
      enabled: document.getElementById('vm-sched-enabled').value === 'true',
      time: document.getElementById('vm-sched-time').value,
      retentionDays: Number(document.getElementById('vm-sched-retention').value),
      targetDir: document.getElementById('vm-sched-target').value,
      targetVm: document.getElementById('vm-sched-vm').value
    };
    const r = await apiFetch('/api/vms/backup-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.success) throw Error(j.error);
    const modeDesc = body.enabled ? `每天 ${body.time} 自动执行` : '自动备份已暂停';
    if (status) {
      status.style.color = '#10b981';
      status.innerHTML = `<i class="fa-solid fa-circle-check" style="margin-right:4px;"></i>策略已保存：${modeDesc} · 保留 ${body.retentionDays} 天版本`;
    }
    vmScheduleFormDirty = false;
    vmShowBackupNotice(`定时自动备份策略已成功更新并生效！(${modeDesc}，保留 ${body.retentionDays} 天版本)`, 'good');
    await vmFetchBackups(true);
    esxiFetchRecentTasks();
  } catch (e) {
    if (status) {
      status.style.color = '#ef4444';
      status.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i>保存失败：${escapeHtml(e.message)}`;
    }
    vmShowBackupNotice('策略保存失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function esxiOpenBackupModal(defaultVmId) {
  const modal = document.getElementById('esxi-backup-modal');
  if (!modal) return;
  const vmSelect = document.getElementById('esxi-bk-vm');
  const targetSelect = document.getElementById('esxi-bk-target');
  const noteInput = document.getElementById('esxi-bk-note');
  const progBox = document.getElementById('esxi-bk-progress-box');
  const startBtn = document.getElementById('esxi-bk-start-btn');
  const cancelBtn = document.getElementById('esxi-bk-cancel-btn');

  if (progBox) progBox.style.display = 'none';
  if (startBtn) { startBtn.disabled = false; startBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> 立即开始热备'; }
  if (cancelBtn) cancelBtn.disabled = false;
  if (noteInput) noteInput.value = '';

  const vms = vmInventory?.vms || [];
  if (!vms.length) {
    alert('未检测到可备份的虚拟机！');
    return;
  }
  const targetId = defaultVmId || vmSelected || (vms[0] ? vms[0].id : '');
  vmSelect.innerHTML = vms.map(v =>
    `<option value="${escapeHtml(v.id)}" ${v.id === targetId ? 'selected' : ''}>${escapeHtml(v.name)} (${vmState[v.state] || '运行中'})</option>`
  ).join('');

  const targets = vmBackupsData?.storageTargets || [];
  if (targets.length) {
    targetSelect.innerHTML = targets.map(t =>
      `<option value="${escapeHtml(t.path)}">${escapeHtml(t.name)} · 剩余 ${t.freeGiB} GiB</option>`
    ).join('');
  } else {
    targetSelect.innerHTML = '<option value="/mnt/raid10/vm-backups">RAID 10 大容量阵列 (/mnt/raid10/vm-backups)</option>';
  }

  modal.style.display = 'flex';
}

function esxiCloseBackupModal() {
  const modal = document.getElementById('esxi-backup-modal');
  if (modal) modal.style.display = 'none';
}

let vmBackupPollTimer = null;
async function esxiSubmitBackup(event) {
  event.preventDefault();
  const vmId = document.getElementById('esxi-bk-vm').value;
  const targetDir = document.getElementById('esxi-bk-target').value;
  const note = document.getElementById('esxi-bk-note').value;
  const v = vmInventory?.vms?.find(x => x.id === vmId);
  const vmName = v ? v.name : '虚拟机';

  const progBox = document.getElementById('esxi-bk-progress-box');
  const progBar = document.getElementById('esxi-bk-progress-bar');
  const progPct = document.getElementById('esxi-bk-progress-pct');
  const progText = document.getElementById('esxi-bk-progress-text');
  const progSub = document.getElementById('esxi-bk-progress-sub');
  const startBtn = document.getElementById('esxi-bk-start-btn');
  const cancelBtn = document.getElementById('esxi-bk-cancel-btn');

  startBtn.disabled = true;
  cancelBtn.disabled = true;
  progBox.style.display = 'block';
  progBar.style.width = '5%';
  progPct.textContent = '5%';
  progText.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>正在建立在线热备镜像流【${escapeHtml(vmName)}】…`;
  progSub.textContent = '正在由 QEMU/libvirt 启动流式写入…';

  vmShowBackupNotice(`正在为【${vmName}】执行系统盘镜像热备，请稍候…`, 'loading');

  if (vmBackupPollTimer) clearInterval(vmBackupPollTimer);
  const startTime = Date.now();
  vmBackupPollTimer = setInterval(async () => {
    try {
      const pr = await apiFetch(`/api/vms/backup-progress?id=${encodeURIComponent(vmId)}`);
      const pj = await pr.json();
      if (pj.success && pj.data && pj.data.active) {
        const pct = Math.max(5, Math.min(99, pj.data.percent || 0));
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const procGiB = (pj.data.processedBytes / 1073741824).toFixed(1);
        const totGiB = (pj.data.totalBytes / 1073741824).toFixed(1);
        progText.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>系统盘热备写入中 (${pct}%)…`;
        progSub.textContent = `已写入 ${procGiB} GiB / ${totGiB} GiB · 耗时 ${elapsed}s`;
      }
    } catch (e) {}
  }, 1000);

  try {
    const res = await vmRequest({ action: 'backup-create', id: vmId, targetDir, note, backupType: 'manual' });
    if (vmBackupPollTimer) clearInterval(vmBackupPollTimer);
    progBar.style.width = '100%';
    progPct.textContent = '100%';
    progText.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#10b981;margin-right:6px;"></i>热备完成！';
    progSub.textContent = `镜像文件：${res.filename} (${vmSize(res.size)})`;
    vmShowBackupNotice(`【${vmName}】系统盘热备成功！生成镜像 ${res.filename} (${vmSize(res.size)})`, 'good');
    await vmFetchBackups();
    esxiFetchRecentTasks();
    setTimeout(() => {
      esxiCloseBackupModal();
    }, 1200);
  } catch (e) {
    if (vmBackupPollTimer) clearInterval(vmBackupPollTimer);
    progText.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;margin-right:6px;"></i>备份失败';
    progSub.textContent = e.message;
    vmShowBackupNotice('备份失败：' + e.message, 'error');
    startBtn.disabled = false;
    cancelBtn.disabled = false;
  }
}

function vmBackupCurrentPrompt(id) {
  esxiOpenBackupModal(id);
}

async function vmRestoreBackup(vmId, vmName, filename, targetDir) {
  const v = vmInventory?.vms?.find(x => x.id === vmId || x.name === vmName);
  if (v && v.state !== 5) {
    alert(`恢复前必须先关闭虚拟机【${vmName}】。\n当前状态：${vmState[v.state] || '运行中'}。\n请在【虚拟机】控制台中先将客户机正常关机，再执行系统盘恢复。`);
    return;
  }
  const conf = prompt(`⚠️ 危险操作：恢复将覆盖虚拟机【${vmName}】当前的系统盘！\n\n备份镜像：${filename}\n\n如确认恢复，请输入虚拟机名称：${vmName}`);
  if (conf !== vmName) return;

  vmShowBackupNotice(`正在恢复【${vmName}】系统盘，请勿刷新页面…`, 'loading');
  try {
    await vmRequest({ action: 'backup-restore', id: v ? v.id : vmId, filename, targetDir, confirmation: vmName });
    vmShowBackupNotice(`【${vmName}】系统盘已成功回滚至备份版本 ${filename}！`, 'good');
    await fetchVMs();
    await vmFetchBackups();
    esxiFetchRecentTasks();
  } catch (e) {
    vmShowBackupNotice('系统盘恢复失败：' + e.message, 'error');
  }
}

async function vmDeleteBackup(filename, targetDir) {
  if (!confirm(`确定永久删除备份镜像文件 ${filename}？\n此操作将释放 RAID 10 磁盘存储空间，无法撤销。`)) return;
  vmShowBackupNotice('正在删除备份镜像…', 'loading');
  try {
    await vmRequest({ action: 'backup-delete', filename, targetDir });
    vmShowBackupNotice(`备份文件已成功删除：${filename}`, 'good');
    await vmFetchBackups();
    esxiFetchRecentTasks();
  } catch (e) {
    vmShowBackupNotice('删除失败：' + e.message, 'error');
  }
}

function vmSize(n) {
  if (!n) return '0 B';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GiB';
  return (n / 1048576).toFixed(1) + ' MiB';
}

/* ─── Power Dropdown & Tab Switching ─── */
function esxiTogglePowerDropdown(event) {
  event.stopPropagation();
  const el = document.getElementById('esxi-power-dropdown-wrap');
  if (el) el.classList.toggle('show');
}
document.addEventListener('click', () => {
  const el = document.getElementById('esxi-power-dropdown-wrap');
  if (el) el.classList.remove('show');
});

let esxiActiveVmTab = 'summary';
function esxiSwitchVmTab(tabName) {
  esxiActiveVmTab = tabName;
  document.getElementById('esxi-tab-btn-summary')?.classList.toggle('active', tabName === 'summary');
  document.getElementById('esxi-tab-btn-monitor')?.classList.toggle('active', tabName === 'monitor');
  const sumTab = document.getElementById('esxi-vm-tab-summary');
  const monTab = document.getElementById('esxi-vm-tab-monitor');
  if (sumTab) sumTab.style.display = (tabName === 'summary' ? 'block' : 'none');
  if (monTab) monTab.style.display = (tabName === 'monitor' ? 'block' : 'none');
  if (tabName === 'monitor' && vmSelected) esxiFetchVmStats(vmSelected);
}

async function esxiFetchVmStats(id) {
  try {
    const v = vmInventory?.vms?.find(x => x.id === id);
    if (!v) return;
    const cpuEl = document.getElementById('esxi-mon-cpu-cores');
    if (cpuEl) cpuEl.textContent = `${v.cpu} vCPUs`;
    const memEl = document.getElementById('esxi-mon-mem-max');
    if (memEl) memEl.textContent = `${v.memory} MiB (${(v.memory / 1024).toFixed(1)} GiB)`;
    const rssEl = document.getElementById('esxi-mon-mem-rss');
    if (v.state === 1 || v.state === 2) {
      const stats = await vmRequest({ action: 'stats', id });
      if (stats && stats.memoryRssMiB && rssEl) {
        rssEl.textContent = `${stats.memoryRssMiB} MiB (${(stats.memoryRssMiB / v.memory * 100).toFixed(1)}%)`;
      } else if (rssEl) {
        rssEl.textContent = '运行中 · 内存已分配';
      }
    } else if (rssEl) {
      rssEl.textContent = '未开机 (0 MiB)';
    }
  } catch (_) {}
}

/* ─── Recent Tasks Drawer ─── */
function esxiToggleTasksDrawer() {
  const drawer = document.getElementById('esxi-tasks-drawer');
  const icon = document.getElementById('esxi-tasks-toggle-icon');
  if (drawer) {
    drawer.classList.toggle('collapsed');
    if (icon) icon.textContent = drawer.classList.contains('collapsed') ? '▸' : '▾';
  }
}

async function esxiFetchRecentTasks() {
  try {
    const r = await apiFetch('/api/vms/tasks');
    const j = await r.json();
    if (!j.success) return;
    const tasks = j.data || [];
    const countEl = document.getElementById('esxi-tasks-count');
    if (countEl) countEl.textContent = tasks.length;
    const tbody = document.getElementById('esxi-tasks-tbody');
    if (tbody) {
      if (!tasks.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:12px;color:var(--esxi-text-muted);">暂无近期任务记录</td></tr>';
        return;
      }
      tbody.innerHTML = tasks.slice(0, 15).map(t => {
        let statusBadge = `<span class="ops-tag ${t.status === '已完成' ? 'good' : (t.status.includes('失败') ? 'danger' : 'warn')}">${escapeHtml(t.status)}</span>`;
        if (t.progress !== undefined && t.progress < 100 && !t.status.includes('失败')) {
          statusBadge = `
            <div style="display:flex;flex-direction:column;gap:3px;min-width:160px;">
              <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:600;color:#00c0ef;">
                <span><i class="fa-solid fa-spinner fa-spin" style="margin-right:4px;"></i>${escapeHtml(t.status)}</span>
                <span>${t.progress}%</span>
              </div>
              <div class="esxi-nav-gauge-bg" style="width:100%;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">
                <div class="esxi-nav-gauge-fill" style="width:${t.progress}%;background:linear-gradient(90deg, #0095d9, #00c0ef);height:100%;transition:width 0.3s ease;"></div>
              </div>
            </div>
          `;
        }
        return `
          <tr>
            <td><i class="fa-solid fa-list-check" style="color:#0095d9;margin-right:6px;"></i><strong>${escapeHtml(t.name)}</strong></td>
            <td>${escapeHtml(t.target)}</td>
            <td>${escapeHtml(t.user)}</td>
            <td>${statusBadge}</td>
            <td>${escapeHtml(t.startTime)}</td>
            <td>${escapeHtml(t.duration)}</td>
          </tr>
        `;
      }).join('');
    }
  } catch (_) {}
}

/* ─── Edit VM Settings Modal ─── */
function esxiOpenEditSettingsModal() {
  if (!vmSelected) return vmMessage('请先选择虚拟机');
  const v = vmInventory?.vms?.find(x => x.id === vmSelected);
  if (!v) return;

  const isRunning = (v.state === 1 || v.state === 2);
  const runningNotice = document.getElementById('esxi-edit-running-notice');
  const offNotice = document.getElementById('esxi-edit-off-notice');
  if (runningNotice) runningNotice.style.display = isRunning ? 'block' : 'none';
  if (offNotice) offNotice.style.display = isRunning ? 'none' : 'block';

  document.getElementById('esxi-edit-vm-name').textContent = v.name;
  document.getElementById('esxi-edit-cpu').value = v.cpu;
  document.getElementById('esxi-edit-ram').value = v.memory;
  esxiUpdateRamHint();
  document.getElementById('esxi-edit-autostart').value = String(v.autostart);

  const cpuHintEl = document.getElementById('esxi-edit-cpu-hint');
  if (cpuHintEl) {
    if (isRunning && v.liveCpu && v.liveCpu !== v.cpu) {
      cpuHintEl.innerHTML = `宿主机总可用: 16 物理线程 · <span style="color:#eab308;font-weight:600;"><i class="fa-solid fa-clock-rotate-left"></i> 当前运行态: ${v.liveCpu} vCPU (已保存配置 ${v.cpu} vCPU 待重启生效)</span>`;
    } else if (isRunning) {
      cpuHintEl.innerHTML = `宿主机总可用: 16 物理线程 (当前运行态: ${v.liveCpu || v.cpu} vCPU · 修改需重启生效)`;
    } else {
      cpuHintEl.textContent = '宿主机总可用: 16 物理线程';
    }
  }

  const ramSubhintEl = document.getElementById('esxi-edit-ram-subhint');
  if (ramSubhintEl) {
    if (isRunning && v.liveMemory && v.liveMemory !== v.memory) {
      ramSubhintEl.innerHTML = `<span style="color:#eab308;font-weight:600;"><i class="fa-solid fa-clock-rotate-left"></i> 当前运行态: ${(v.liveMemory/1024).toFixed(1)} GiB (已保存配置 ${(v.memory/1024).toFixed(1)} GiB 待重启生效)</span>`;
    } else if (isRunning) {
      ramSubhintEl.innerHTML = `系统运行内存 (当前运行态: ${((v.liveMemory || v.memory)/1024).toFixed(1)} GiB · 修改需重启生效)`;
    } else {
      ramSubhintEl.textContent = '系统运行内存';
    }
  }

  // System disk capacity
  const sysDisk = (v.disks || []).find(x => x.device === 'disk' && (x.type === 'file' || x.driver === 'qcow2')) || v.disks?.[0];
  const diskInput = document.getElementById('esxi-edit-disk');
  const currDiskEl = document.getElementById('esxi-edit-disk-curr');
  const currSize = v.diskSize || (sysDisk && sysDisk.capacityGiB ? Math.round(sysDisk.capacityGiB) : 32);
  if (diskInput) {
    diskInput.value = currSize;
    diskInput.min = currSize;
  }
  if (currDiskEl) currDiskEl.textContent = currSize;

  // Passthrough disks list
  const ptCard = document.getElementById('esxi-edit-passthrough-card');
  const ptList = document.getElementById('esxi-edit-passthrough-list');
  const ptDisks = (v.disks || []).filter(x => x.type === 'block' || (x.path && x.path.startsWith('/dev/')));
  if (ptCard) {
    ptCard.style.display = ptDisks.length ? 'block' : 'none';
  }
  if (ptList) {
    if (ptDisks.length) {
      ptList.innerHTML = ptDisks.map((d, idx) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--esxi-border);">
          <span><i class="fa-solid fa-database" style="color:var(--esxi-text-muted);margin-right:6px;"></i><strong>${escapeHtml(d.target || ('sd' + String.fromCharCode(99+idx)))}:</strong> 物理磁盘 (直通给客户机)</span>
          <span style="font-family:monospace;font-size:11px;color:var(--esxi-text-muted);">S/N: ${escapeHtml(d.serial || 'SAS-DISK')} | ${d.capacityGiB ? d.capacityGiB + ' GB' : '900 GB'}</span>
        </div>
      `).join('');
    } else {
      ptList.innerHTML = '<span style="color:var(--esxi-text-muted);">暂无物理直通磁盘</span>';
    }
  }

  const isoSelect = document.getElementById('esxi-edit-iso');
  isoSelect.innerHTML = '<option value="">不挂载镜像 (弹出光驱)</option>' + (vmInventory.isos || []).map(i => {
    const dsBadge = i.datastore ? `[${i.datastore}] ` : '';
    return `<option value="${escapeHtml(i.name)}">${dsBadge}${escapeHtml(i.name)}</option>`;
  }).join('');
  const cd = (v.disks || []).find(x => x.device === 'cdrom');
  isoSelect.value = cd?.path ? cd.path.split('/').pop() : '';

  // Network interfaces (Multi-NIC support)
  vmEditNics = (v.interfaces && v.interfaces.length)
    ? v.interfaces.map(iface => ({
        mode: iface.type === 'direct' ? (iface.mode === 'passthrough' ? 'passthrough' : 'bridge') : 'nat',
        dev: iface.source || 'enp8s0f1',
        mac: iface.mac
      }))
    : [{ mode: 'bridge', dev: 'enp8s0f1' }];
  esxiRenderEditNics();
  document.getElementById('esxi-edit-settings-modal').style.display = 'flex';
}

function esxiUpdateRamHint() {
  const ramInput = document.getElementById('esxi-edit-ram');
  const hintEl = document.getElementById('esxi-edit-ram-hint');
  if (ramInput && hintEl) {
    const val = Number(ramInput.value) || 0;
    hintEl.textContent = (val / 1024).toFixed(1) + ' GiB';
  }
}

function esxiCloseEditSettingsModal() {
  document.getElementById('esxi-edit-settings-modal').style.display = 'none';
}

function esxiOnEditNetModeChange() {
  const mode = document.getElementById('esxi-edit-net-mode').value;
  const wrap = document.getElementById('esxi-edit-net-dev-wrap');
  if (wrap) wrap.style.display = (mode === 'nat' ? 'none' : '');
  const tip = document.getElementById('esxi-edit-net-tip');
  if (tip) tip.innerHTML = getNetModeTipHtml(mode);
}

async function esxiSubmitEditSettings(event) {
  event.preventDefault();
  if (!vmSelected || vmBusy) return;
  vmBusy = true;
  try {
    const bootDev = document.getElementById('esxi-edit-boot').value;
    const bootOrder = (bootDev === 'cdrom' ? ['cdrom', 'hd'] : ['hd', 'cdrom']);
    const diskSize = Number(document.getElementById('esxi-edit-disk').value);
    for (const nic of vmEditNics) {
      if (nic.mode === 'passthrough') {
        const isMgmt = (vmInventory?.networkInterfaces || []).find(x => x.name === nic.dev)?.isDefault;
        if (isMgmt) {
          throw Error(`严禁将宿主机主管理口【${nic.dev}】设为独占直通，否则宿主机将失去网络连接！请更换为其他物理网口。`);
        }
      }
    }

    await vmRequest({
      action: 'edit-settings',
      id: vmSelected,
      cpu: Number(document.getElementById('esxi-edit-cpu').value),
      memory: Number(document.getElementById('esxi-edit-ram').value),
      diskSize: diskSize,
      autostart: document.getElementById('esxi-edit-autostart').value === 'true',
      bootOrder,
      iso: document.getElementById('esxi-edit-iso').value,
      interfaces: vmEditNics.map(x => ({ mode: x.mode, dev: x.dev, mac: x.mac }))
    });
    const curVm = vmInventory?.vms?.find(x => x.id === vmSelected);
    if (curVm && (curVm.state === 1 || curVm.state === 2)) {
      vmMessage(`虚拟机【${curVm.name}】配置已成功保存！磁盘已在线热扩容；网卡直通及硬件修改已写入配置，将在虚拟机重启后生效。`);
    } else {
      vmMessage(`虚拟机【${curVm?.name || 'VM'}】硬件与网卡配置已成功更新保存！`);
    }
    esxiCloseEditSettingsModal();
    await fetchVMs();
  } catch (e) {
    alert('保存设置失败：' + e.message);
  } finally {
    vmBusy = false;
  }
}

/* ─── Clone VM Modal ─── */
function esxiOpenCloneModal() {
  if (!vmSelected) return vmMessage('请先选择虚拟机');
  const v = vmInventory?.vms?.find(x => x.id === vmSelected);
  if (!v) return;
  if (v.state !== 5) {
    alert(`克隆前需先关闭虚拟机【${v.name}】以保证虚拟磁盘完整性。\n当前状态：${vmState[v.state] || '运行中'}\n请先在页面上正常关机。`);
    return;
  }
  document.getElementById('esxi-clone-source-name').textContent = v.name;
  document.getElementById('esxi-clone-new-name').value = `${v.name}-Clone`;
  const dsSelect = document.getElementById('esxi-clone-datastore');
  if (vmInventory?.datastores) {
    dsSelect.innerHTML = vmInventory.datastores.map(ds =>
      `<option value="${escapeHtml(ds.id)}">${escapeHtml(ds.name)} (剩余 ${ds.freeGiB} GiB)</option>`
    ).join('');
  }
  document.getElementById('esxi-clone-vm-modal').style.display = 'flex';
}

function esxiCloseCloneModal() {
  document.getElementById('esxi-clone-vm-modal').style.display = 'none';
}

async function esxiSubmitCloneVm(event) {
  event.preventDefault();
  if (!vmSelected || vmBusy) return;
  vmBusy = true;
  const btn = document.getElementById('esxi-clone-btn');
  btn.disabled = true;
  const newName = document.getElementById('esxi-clone-new-name').value.trim();
  const dsId = document.getElementById('esxi-clone-datastore').value;
  vmMessage(`正在克隆系统盘创建虚拟机【${newName}】，请稍候…`);
  try {
    const newVm = await vmRequest({
      action: 'clone',
      id: vmSelected,
      newName,
      datastoreId: dsId
    });
    vmMessage(`虚拟机【${newVm.name}】克隆成功！`);
    esxiCloseCloneModal();
    await fetchVMs();
    esxiSelectVm(newVm.id);
  } catch (e) {
    alert('克隆失败：' + e.message);
  } finally {
    vmBusy = false;
    btn.disabled = false;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// ─── PVE-STYLE CT CONTAINERS (LXC) MANAGEMENT ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
let ctInventory = null;
let ctSelected = null;
let ctFetching = false;


// Sidebar CT sub-tree is disabled per user preference (keep sidebar clean)
function esxiUpdateNavCtTree(cts) {
  // Intentionally empty
}

// Global CT filter state
let ctFilterQuery = '';
let ctFilterState = 'all';

function esxiFilterCtTable(query, state) {
  if (query !== undefined) ctFilterQuery = (query || '').toLowerCase().trim();
  if (state !== undefined) ctFilterState = state;
  
  if (!ctInventory || !ctInventory.cts) return;
  let filtered = ctInventory.cts;
  if (ctFilterState === 'running') {
    filtered = filtered.filter(c => c.state === 1);
  } else if (ctFilterState === 'stopped') {
    filtered = filtered.filter(c => c.state !== 1);
  }
  if (ctFilterQuery) {
    filtered = filtered.filter(c => 
      (c.name && c.name.toLowerCase().includes(ctFilterQuery)) ||
      (String(c.vmid || c.id).includes(ctFilterQuery)) ||
      (c.ips && c.ips.some(ip => ip.includes(ctFilterQuery)))
    );
  }
  esxiRenderCtTable(filtered);
}
window.esxiFilterCtTable = esxiFilterCtTable;
window.esxiUpdateNavCtTree = esxiUpdateNavCtTree;

async function fetchCts() {
  if (ctFetching) return;
  ctFetching = true;
  try {
    const r = await apiFetch('/api/vms/cts');
    const j = await r.json();
    if (!j.success) throw Error(j.error);
    ctInventory = j.data;
    fetchCtTemplates().catch(() => {});

    const badge = document.getElementById('esxi-badge-cts');
    if (badge) {
      const count = j.data?.cts?.length || 0;
      badge.textContent = count;
    }

    esxiRenderCtTable(j.data.cts || []);
    esxiUpdateNavCtTree(j.data.cts || []);

    if (j.data.cts && j.data.cts.length > 0) {
      if (!ctSelected || !j.data.cts.some(c => c.id === ctSelected || c.name === ctSelected)) {
        ctSelected = j.data.cts[0].id;
      }
      esxiSelectCt(ctSelected);
    } else {
      ctSelected = null;
      const details = document.getElementById('esxi-ct-details-wrapper');
      if (details) details.style.display = 'none';
      esxiUpdateCtToolbarButtons(null);
    }
  } catch (e) {
    console.warn('[CTs] fetch error:', e);
    const tbody = document.getElementById('esxi-ct-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:#ef4444;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>获取 CT 容器失败: ${escapeHtml(e.message)}</td></tr>`;
    }
  } finally {
    ctFetching = false;
  }
}

function esxiRenderCtTable(cts) {
  const tbody = document.getElementById('esxi-ct-tbody');
  if (!tbody) return;

  if (!cts || cts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center;padding:40px 16px;color:var(--esxi-text-muted);">
          <div style="font-size:36px;color:#00c0ef;margin-bottom:12px;"><i class="fa-solid fa-cube"></i></div>
          <div style="font-size:15px;font-weight:600;color:var(--esxi-text);margin-bottom:6px;">当前暂无 CT 容器</div>
          <div style="font-size:12px;margin-bottom:16px;">基于 Linux 内核 Namespaces 与 cgroups 的轻量级容器（PVE LXC 架构），轻量高效秒级秒开。</div>
          <button class="esxi-btn esxi-btn-primary" onclick="vmOpenCreateCtModal()"><i class="fa-solid fa-plus"></i> 立即创建首个 CT 容器</button>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = cts.map(c => {
    const isSelected = (c.id === ctSelected || c.name === ctSelected);
    const isRunning = (c.state === 1);
    const isFrozen = (c.state === 3);

    let statePill = '<span class="esxi-status-pill" style="background:rgba(100,116,139,0.2);color:#94a3b8;">■ 已停止</span>';
    if (isRunning) {
      statePill = '<span class="esxi-status-pill" style="background:rgba(34,197,94,0.15);color:#22c55e;"><span style="color:#22c55e;margin-right:4px;">●</span>运行中</span>';
    } else if (isFrozen) {
      statePill = '<span class="esxi-status-pill" style="background:rgba(245,158,11,0.15);color:#f59e0b;">⏸ 已挂起</span>';
    }

    const ipText = (c.ips && c.ips.length) ? c.ips.join(', ') : '<span style="color:var(--esxi-text-muted);">-</span>';
    const ramText = c.memoryLimitMiB ? `${c.memoryUsedMiB || 0} / ${c.memoryLimitMiB} MiB` : `${c.memoryUsedMiB || 0} MiB (共享全量)`;
    const cpuText = c.cpuAllocation || '全部共享';
    const autostartPill = c.autostart ? '<span style="color:#22c55e;font-weight:600;">是</span>' : '<span style="color:var(--esxi-text-muted);">否</span>';

    const isSsd = c.rootfs && c.rootfs.includes('/mnt/vadata');
    const dsBadge = isSsd 
      ? '<span class="ops-tag good" style="font-size:10px;padding:1px 5px;margin-left:4px;">SSD</span>' 
      : (c.rootfs && c.rootfs.includes('/mnt/raid10') ? '<span class="ops-tag" style="font-size:10px;padding:1px 5px;margin-left:4px;">RAID10</span>' : '<span class="ops-tag" style="font-size:10px;padding:1px 5px;margin-left:4px;">系统盘</span>');

    return `
      <tr class="${isSelected ? 'selected' : ''}" onclick="esxiSelectCt('${escapeHtml(c.id)}')">
        <td style="text-align:center;">
          <input type="radio" name="ct-select" ${isSelected ? 'checked' : ''} onchange="esxiSelectCt('${escapeHtml(c.id)}')">
        </td>
        <td><strong style="color:#00c0ef;">${c.vmid || c.id}</strong></td>
        <td>
          <div style="font-weight:600;color:var(--esxi-text);display:flex;align-items:center;gap:6px;">
            <i class="fa-solid fa-cube" style="color:#00c0ef;font-size:12px;"></i>
            <span>${escapeHtml(c.name)}</span>
            ${dsBadge}
          </div>
        </td>
        <td>${statePill}</td>
        <td><span style="font-family:monospace;font-size:12px;color:#0095d9;">${ipText}</span></td>
        <td>${escapeHtml(cpuText)}</td>
        <td>${ramText}</td>
        <td style="color:#38bdf8;">${escapeHtml(c.os || 'Alpine Linux')}</td>
        <td style="text-align:center;">${autostartPill}</td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="esxi-btn esxi-btn-sm" onclick="event.stopPropagation(); ctOpenConsole('${escapeHtml(c.id)}')" title="打开控制台">
            <i class="fa-solid fa-terminal" style="color:#00c0ef;"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}


function ctGenerateRandomMac(targetInput) {
  const hex = '0123456789abcdef';
  let mac = '52:54:00';
  for (let i = 0; i < 3; i++) {
    mac += ':' + hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)];
  }
  if (targetInput && targetInput.value !== undefined) {
    targetInput.value = mac;
  } else if (typeof targetInput === 'string') {
    const el = document.getElementById(targetInput);
    if (el) el.value = mac;
  }
  return mac;
}

function ctBuildNicOptionsHtml(selectedVal) {
  const ifaces = (ctInventory && ctInventory.hostInterfaces) || window.ctHostInterfaces || [];
  let macvlanOptions = '';
  let physOptions = '';
  let bridgeOptions = '';

  // 1. Primary LAN Shared Interface
  const prim = ifaces.find(i => i.isPrimary) || { name: 'enp8s0f1' };
  const primVal = prim.name;
  const isPrimSel = (!selectedVal || selectedVal === primVal || selectedVal === 'macvlan' || selectedVal === 'lan');
  macvlanOptions += `<option value="${primVal}" ${isPrimSel ? 'selected' : ''}>${primVal} (主管理网口 · 共享 Macvlan · 局域网同网段 192.168.1.x · 推荐)</option>`;

  // 2. Physical Dedicated Passthrough Interfaces
  const physIfaces = ifaces.filter(i => !i.isVirtual && !i.isPrimary);
  if (physIfaces.length > 0) {
    physIfaces.forEach(p => {
      const val = `phys:${p.name}`;
      const isSel = (selectedVal === val || selectedVal === p.name);
      const carrierTag = p.carrier ? '🟢 已插网线' : '⚪ 未插网线';
      const speedTag = p.speed ? `(${p.speed})` : '';
      const inUseTag = p.inUseBy ? ` [已分配给 ${p.inUseBy}]` : '';
      physOptions += `<option value="${val}" ${isSel ? 'selected' : ''}>${p.name} · 直通独占 ${speedTag} · ${carrierTag}${inUseTag}</option>`;
    });
  } else {
    ['enp7s0f1', 'enp5s0f0', 'enp5s0f1', 'enp12s0f0', 'enp7s0f0'].forEach(nic => {
      const val = `phys:${nic}`;
      physOptions += `<option value="${val}" ${selectedVal === val ? 'selected' : ''}>${nic} (10G 物理网卡独占直通)</option>`;
    });
  }

  // 3. Virtual Bridges
  const bridges = ifaces.filter(i => i.isBridge) || [];
  if (bridges.length > 0) {
    bridges.forEach(b => {
      const isSel = (selectedVal === b.name);
      bridgeOptions += `<option value="${b.name}" ${isSel ? 'selected' : ''}>${b.name} (内部虚拟网桥)</option>`;
    });
  } else {
    bridgeOptions += `<option value="lxcbr0" ${selectedVal === 'lxcbr0' ? 'selected' : ''}>lxcbr0 (NAT 内部隔离网桥 · 自动分配 10.0.3.x)</option>`;
    bridgeOptions += `<option value="virbr0" ${selectedVal === 'virbr0' ? 'selected' : ''}>virbr0 (KVM 默认虚拟网桥 · 192.168.122.x)</option>`;
  }

  return `
    <optgroup label="── 物理局域网共享 (Macvlan 共享物理口 · 局域网同网段 192.168.1.x) ──">
      ${macvlanOptions}
    </optgroup>
    <optgroup label="── 物理网卡独占直通 (PCI 硬件直通 · 插入网线做业务口/软路由) ──">
      ${physOptions}
    </optgroup>
    <optgroup label="── 虚拟交换网桥 (内部隔离网络) ──">
      ${bridgeOptions}
    </optgroup>
  `;
}

function ctCreateNicCardElement(mode, idx, net) {
  const card = document.createElement('div');
  card.className = 'ct-nic-card';
  card.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:10px 12px;';

  let selectedLink = net.link || 'enp8s0f1';
  if (net.type === 'phys' && !selectedLink.startsWith('phys:')) {
    selectedLink = `phys:${selectedLink}`;
  }

  const isPrimary = (idx === 0);
  const badgeText = isPrimary ? '网卡 1 (eth0 · 推荐管理与监控口)' : `网卡 ${idx + 1} (eth${idx} · 业务直通网卡)`;
  const badgeColor = isPrimary ? '#0ea5e9' : '#22c55e';

  const deleteBtnHtml = isPrimary ? '' : `
    <button type="button" class="mac-btn mac-btn-sm" onclick="this.closest('.ct-nic-card').remove(); ctReindexNics('${mode}');" title="删除此网卡" style="color:#ef4444;border-color:rgba(239,68,68,0.3);padding:2px 8px;font-size:11px;">
      <i class="fa-solid fa-trash"></i> 删除
    </button>
  `;

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="font-size:12px;font-weight:600;color:${badgeColor};display:flex;align-items:center;gap:6px;">
        <i class="fa-solid fa-network-wired"></i>
        <span class="ct-nic-title">${badgeText}</span>
      </div>
      ${deleteBtnHtml}
    </div>
    <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:12px;">
      <div>
        <label class="mac-label" style="font-size:11px;">绑定网络模式 / 物理接口</label>
        <select class="mac-select ct-nic-bridge-select" style="font-size:12px;padding:5px 8px;">
          ${ctBuildNicOptionsHtml(selectedLink)}
        </select>
      </div>
      <div>
        <label class="mac-label" style="font-size:11px;">MAC 硬件地址 (物理直通自动透传)</label>
        <div style="display:flex;gap:6px;">
          <input type="text" class="mac-input ct-nic-mac-input" value="${escapeHtml(net.hwaddr || '')}" placeholder="自动生成或物理直通" style="font-family:monospace;font-size:11px;padding:5px 8px;">
          <button type="button" class="mac-btn" onclick="ctGenerateRandomMac(this.previousElementSibling)" title="随机生成 MAC" style="padding:0 8px;"><i class="fa-solid fa-shuffle"></i></button>
        </div>
      </div>
    </div>
  `;
  return card;
}

function ctReindexNics(mode) {
  const containerId = (mode === 'create') ? 'ct-create-nics-container' : 'ct-edit-nics-container';
  const container = document.getElementById(containerId);
  if (!container) return;
  const cards = container.querySelectorAll('.ct-nic-card');
  cards.forEach((card, idx) => {
    const title = card.querySelector('.ct-nic-title');
    if (title) {
      if (idx === 0) {
        title.textContent = '网卡 1 (eth0 · 推荐管理与监控口)';
      } else {
        title.textContent = `网卡 ${idx + 1} (eth${idx} · 业务直通网卡)`;
      }
    }
  });
}

function ctRenderEditNics(networks) {
  const container = document.getElementById('ct-edit-nics-container');
  if (!container) return;
  const nets = (networks && networks.length > 0) ? networks : [{ name: 'eth0', link: 'enp8s0f1', type: 'macvlan' }];
  container.innerHTML = '';
  nets.forEach((n, idx) => {
    container.appendChild(ctCreateNicCardElement('edit', idx, n));
  });
}

function ctAddEditNic() {
  const container = document.getElementById('ct-edit-nics-container');
  if (!container) return;
  const count = container.querySelectorAll('.ct-nic-card').length;
  const ifaces = (ctInventory && ctInventory.hostInterfaces) || window.ctHostInterfaces || [];
  const physIfaces = ifaces.filter(i => !i.isVirtual && !i.isPrimary);
  let defaultLink = (physIfaces.length > 0) ? `phys:${physIfaces[0].name}` : 'lxcbr0';
  const card = ctCreateNicCardElement('edit', count, { name: `eth${count}`, link: defaultLink, type: 'phys' });
  container.appendChild(card);
}

function ctRenderCreateNics(networks) {
  const container = document.getElementById('ct-create-nics-container');
  if (!container) return;
  const nets = (networks && networks.length > 0) ? networks : [{ name: 'eth0', link: 'enp8s0f1', type: 'macvlan' }];
  container.innerHTML = '';
  nets.forEach((n, idx) => {
    container.appendChild(ctCreateNicCardElement('create', idx, n));
  });
}

function ctAddCreateNic() {
  const container = document.getElementById('ct-create-nics-container');
  if (!container) return;
  const count = container.querySelectorAll('.ct-nic-card').length;
  const ifaces = (ctInventory && ctInventory.hostInterfaces) || window.ctHostInterfaces || [];
  const physIfaces = ifaces.filter(i => !i.isVirtual && !i.isPrimary);
  let defaultLink = (physIfaces.length > 0) ? `phys:${physIfaces[0].name}` : 'lxcbr0';
  const card = ctCreateNicCardElement('create', count, { name: `eth${count}`, link: defaultLink, type: 'phys' });
  container.appendChild(card);
}

window.ctAddEditNic = ctAddEditNic;
window.ctAddCreateNic = ctAddCreateNic;
window.ctGenerateRandomMac = ctGenerateRandomMac;
window.ctReindexNics = ctReindexNics;

function ctOpenEditSettingsModal(idOrName) {
  const targetId = idOrName || ctSelected;
  if (!targetId) {
    alert('请先在列表中选中一个 CT 容器');
    return;
  }
  const c = ctInventory?.cts?.find(x => x.id === targetId || x.name === targetId);
  if (!c) {
    alert('未找到指定的 CT 容器');
    return;
  }

  const modal = document.getElementById('vm-ct-edit-modal');
  if (!modal) return;

  document.getElementById('ct-edit-modal-title').textContent = `编辑 CT 容器配置 - ${c.name} (${c.vmid || c.id})`;
  document.getElementById('ct-edit-name').value = c.name;
  document.getElementById('ct-edit-hostname').value = c.name;
  document.getElementById('ct-edit-autostart').value = c.autostart ? 'true' : 'false';

  let coreCount = '1';
  if (c.cpuAllocation) {
    if (String(c.cpuAllocation).includes('-')) {
      const parts = String(c.cpuAllocation).split('-');
      coreCount = String(parseInt(parts[1]) - parseInt(parts[0]) + 1);
    } else if (String(c.cpuAllocation).match(/^\d+$/)) {
      coreCount = String(parseInt(c.cpuAllocation) + 1);
    }
  }
  const coresSelect = document.getElementById('ct-edit-cores');
  if (coresSelect) {
    if ([...coresSelect.options].some(o => o.value === coreCount)) {
      coresSelect.value = coreCount;
    } else {
      coresSelect.value = '1';
    }
  }

  const ramSelect = document.getElementById('ct-edit-ram');
  if (ramSelect) {
    const mem = String(c.memoryLimitMiB || '512');
    if ([...ramSelect.options].some(o => o.value === mem)) {
      ramSelect.value = mem;
    } else {
      ramSelect.value = '512';
    }
  }

  // Render Multi-NICs in Edit Modal
  ctRenderEditNics(c.network);

  const ipInput = document.getElementById('ct-edit-ip');
  if (ipInput) {
    ipInput.value = c.staticIp || '';
  }

  const gwInput = document.getElementById('ct-edit-gateway');
  if (gwInput) {
    gwInput.value = c.gateway || '192.168.1.1';
  }

  const pwdInput = document.getElementById('ct-edit-password');
  if (pwdInput) {
    pwdInput.value = '';
  }

  const rootfsEl = document.getElementById('ct-edit-rootfs');
  if (rootfsEl) rootfsEl.textContent = c.rootfs || '-';

  const dsEl = document.getElementById('ct-edit-datastore');
  if (dsEl) {
    const rf = c.rootfs || '';
    dsEl.textContent = rf.includes('/mnt/vadata') ? 'datastore-ssd (高速闪存)' : (rf.includes('/mnt/raid10') ? 'datastore-raid10 (大容量阵列)' : 'datastore1 (系统盘)');
  }

  const osEl = document.getElementById('ct-edit-os');
  if (osEl) osEl.textContent = c.os || 'Linux';

  modal.style.display = 'flex';
  modal.removeAttribute('hidden');
}

function ctCloseEditSettingsModal() {
  const modal = document.getElementById('vm-ct-edit-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('hidden', '');
  }
}

async function ctSubmitEditSettings(e) {
  e.preventDefault();
  const btn = document.getElementById('ct-edit-submit-btn');
  const name = document.getElementById('ct-edit-name')?.value;
  if (!name) return;

  const hostname = document.getElementById('ct-edit-hostname')?.value;
  const autostart = document.getElementById('ct-edit-autostart')?.value === 'true';
  const cores = parseInt(document.getElementById('ct-edit-cores')?.value || '1');
  const memoryMiB = parseInt(document.getElementById('ct-edit-ram')?.value || '512');
  const ip = document.getElementById('ct-edit-ip')?.value?.trim();
  const gateway = document.getElementById('ct-edit-gateway')?.value?.trim();
  const password = document.getElementById('ct-edit-password')?.value;

  // Collect Multi-NIC configurations
  const nicCards = document.querySelectorAll('#ct-edit-nics-container .ct-nic-card');
  const networks = [];
  nicCards.forEach((card, idx) => {
    const bridgeSelect = card.querySelector('.ct-nic-bridge-select');
    const macInput = card.querySelector('.ct-nic-mac-input');
    const selVal = bridgeSelect?.value || 'enp8s0f1';
    const isPhys = selVal.startsWith('phys:');
    const isMacvlan = (selVal === 'enp8s0f1' || selVal === 'macvlan');
    networks.push({
      index: idx,
      name: `eth${idx}`,
      link: isPhys ? selVal.replace('phys:', '') : selVal,
      type: isPhys ? 'phys' : (isMacvlan ? 'macvlan' : 'veth'),
      hwaddr: macInput?.value?.trim() || ''
    });
  });

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在写入配置...';
  }

  try {
    const res = await apiFetch('/api/vms/cts/edit-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hostname, autostart, cores, memoryMiB, networks, ip, gateway, password })
    });
    const j = await res.json();
    if (!j.success) throw new Error(j.error || j.message);
    alert(j.message || `CT 容器 ${name} 配置已更新！`);
    ctCloseEditSettingsModal();
    fetchCts();
  } catch (err) {
    alert(`保存配置失败: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> 保存并应用配置';
    }
  }
}

function esxiSelectCt(idOrName) {
  if (!idOrName) return;
  ctSelected = idOrName;

  document.querySelectorAll('#esxi-ct-table tbody tr').forEach(row => {
    const radio = row.querySelector('input[type="radio"]');
    if (row.getAttribute('onclick')?.includes(`'${idOrName}'`)) {
      row.classList.add('selected');
      if (radio) radio.checked = true;
    } else {
      row.classList.remove('selected');
      if (radio) radio.checked = false;
    }
  });

  const c = ctInventory?.cts?.find(x => x.id === idOrName || x.name === idOrName);
  esxiUpdateCtToolbarButtons(c);
  esxiRenderCtSummary(c);
  if (ctInventory && ctInventory.cts) esxiUpdateNavCtTree(ctInventory.cts);
}

function esxiUpdateCtToolbarButtons(c) {
  const btnStart = document.getElementById('esxi-ct-btn-start');
  const btnShutdown = document.getElementById('esxi-ct-btn-shutdown');
  const btnKill = document.getElementById('esxi-ct-btn-kill');
  const btnReboot = document.getElementById('esxi-ct-btn-reboot');
  const btnEdit = document.getElementById('esxi-ct-btn-edit');
  const btnConsole = document.getElementById('esxi-ct-btn-console');
  const btnDestroy = document.getElementById('esxi-ct-btn-destroy');

  if (!c) {
    if (btnStart) btnStart.disabled = true;
    if (btnShutdown) btnShutdown.disabled = true;
    if (btnKill) btnKill.disabled = true;
    if (btnReboot) btnReboot.disabled = true;
    if (btnEdit) btnEdit.disabled = true;
    if (btnConsole) btnConsole.disabled = true;
    if (btnDestroy) btnDestroy.disabled = true;
    return;
  }

  const isRunning = (c.state === 1);
  if (btnStart) btnStart.disabled = isRunning;
  if (btnShutdown) btnShutdown.disabled = !isRunning;
  if (btnKill) btnKill.disabled = !isRunning;
  if (btnReboot) btnReboot.disabled = !isRunning;
  if (btnEdit) btnEdit.disabled = false;
  if (btnConsole) btnConsole.disabled = false;
  if (btnDestroy) btnDestroy.disabled = false;
}

function esxiRenderCtSummary(c) {
  const wrap = document.getElementById('esxi-ct-details-wrapper');
  if (!wrap) return;
  if (!c) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';

  const isRunning = (c.state === 1);
  const sumState = document.getElementById('esxi-ct-sum-state');
  if (sumState) {
    if (isRunning) {
      sumState.textContent = '运行中';
      sumState.style.background = 'rgba(34,197,94,0.15)';
      sumState.style.color = '#22c55e';
    } else {
      sumState.textContent = '已停止';
      sumState.style.background = 'rgba(100,116,139,0.2)';
      sumState.style.color = '#94a3b8';
    }
  }

  const sumName = document.getElementById('esxi-ct-sum-name');
  if (sumName) sumName.textContent = c.name;
  const sumTitle = document.getElementById('esxi-ct-sum-title');
  if (sumTitle) sumTitle.textContent = `${c.name} (${c.vmid || c.id})`;
  const sumVmid = document.getElementById('esxi-ct-sum-vmid');
  if (sumVmid) sumVmid.textContent = `VMID: ${c.vmid || c.id}`;

  const sumPid = document.getElementById('esxi-ct-sum-pid');
  if (sumPid) sumPid.textContent = c.pid || '-';

  const sumIp = document.getElementById('esxi-ct-sum-ip');
  if (sumIp) {
    const ipMode = c.staticIp ? ' [静态 IP]' : (c.ips && c.ips.length ? ' [DHCP 自动分配]' : '');
    const ipStr = (c.ips && c.ips.length) ? (c.ips.join(', ') + ipMode) : '未获取或离线';
    sumIp.textContent = ipStr;
  }

  const sumAutostart = document.getElementById('esxi-ct-sum-autostart');
  if (sumAutostart) sumAutostart.textContent = c.autostart ? '已启用 (跟随宿主机开机启动)' : '未启用';

  const sumCpu = document.getElementById('esxi-ct-sum-cpu');
  if (sumCpu) sumCpu.textContent = c.cpuAllocation || '全部核心共享';

  const sumArch = document.getElementById('esxi-ct-sum-arch');
  if (sumArch) sumArch.textContent = c.arch || 'x86_64';

  const sumMem = document.getElementById('esxi-ct-sum-mem');
  if (sumMem) sumMem.textContent = c.memoryLimitMiB ? `${c.memoryLimitMiB} MiB` : '无限制 (宿主机内存全量共享)';

  const sumMemUsed = document.getElementById('esxi-ct-sum-memused');
  if (sumMemUsed) sumMemUsed.textContent = `${c.memoryUsedMiB || 0} MiB`;

  const sumRootfs = document.getElementById('esxi-ct-sum-rootfs');
  if (sumRootfs) {
    const rf = c.rootfs || `/var/lib/lxc/${c.name}/rootfs`;
    const isSsd = rf.includes('/mnt/vadata');
    const isRaid = rf.includes('/mnt/raid10');
    const poolTag = isSsd 
      ? '<span class="ops-tag good" style="font-size:10px;margin-left:6px;"><i class="fa-solid fa-bolt"></i> datastore-ssd (高速闪存)</span>' 
      : (isRaid ? '<span class="ops-tag" style="font-size:10px;margin-left:6px;"><i class="fa-solid fa-database"></i> datastore-raid10 (大容量阵列)</span>' : '<span class="ops-tag" style="font-size:10px;margin-left:6px;">datastore1 (系统盘)</span>');
    sumRootfs.innerHTML = `<span style="font-family:monospace;font-size:12px;">${escapeHtml(rf)}</span>${poolTag}`;
  }

  const sumOs = document.getElementById('esxi-ct-sum-os');
  if (sumOs) sumOs.textContent = c.os || 'Alpine Linux';

  const sumBridge = document.getElementById('esxi-ct-sum-bridge');
  if (sumBridge) {
    const nets = (c.network && c.network.length > 0) ? c.network : [{}];
    sumBridge.innerHTML = nets.map((net, idx) => {
      const nName = net.name || `eth${idx}`;
      if (net.type === 'phys') {
        return `<div style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;" class="ops-tag good" style="font-size:11px;">
          <i class="fa-solid fa-bolt" style="color:#22c55e;"></i> <strong>${nName}</strong>: ${escapeHtml(net.link || '')} (10G 物理网卡独占直通)
        </div>`;
      } else if (net.type === 'macvlan' || net.link === 'enp8s0f1') {
        return `<div style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;" class="ops-tag" style="font-size:11px;background:rgba(14,165,233,0.15);color:#38bdf8;border:1px solid rgba(14,165,233,0.3);">
          <i class="fa-solid fa-network-wired"></i> <strong>${nName}</strong>: ${escapeHtml(net.link || 'enp8s0f1')} (物理局域网共享 · 192.168.1.x)
        </div>`;
      } else {
        return `<div style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;" class="ops-tag" style="font-size:11px;">
          <i class="fa-solid fa-circle-nodes"></i> <strong>${nName}</strong>: ${escapeHtml(net.link || 'lxcbr0')} (内部网桥)
        </div>`;
      }
    }).join('');
  }
}

async function ctActionSelected(action) {
  if (!ctSelected) {
    alert('请先在列表中选中一个 CT 容器');
    return;
  }
  const c = ctInventory?.cts?.find(x => x.id === ctSelected || x.name === ctSelected);
  const name = c ? c.name : ctSelected;

  if (action === 'destroy') {
    if (!confirm(`【危险操作】确定要彻底销毁并删除 CT 容器 ${name} (VMID: ${c?.vmid || ctSelected}) 吗？\n所有容器内数据将被永久删除且不可恢复！`)) {
      return;
    }
  } else if (action === 'kill') {
    if (!confirm(`确定要强制停止 (kill) CT 容器 ${name} 吗？`)) {
      return;
    }
  }

  try {
    const r = await apiFetch('/api/vms/cts/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ctSelected, action })
    });
    const j = await r.json();
    if (!j.success) throw Error(j.error || j.message);
    alert(j.message || `操作已成功执行`);
    fetchCts();
  } catch (e) {
    alert(`操作失败: ${e.message}`);
  }
}

let ctCurrentConsoleName = null;
let ctConsoleHistory = [];
let ctConsoleHistoryIdx = -1;

function ctOpenSelectedConsole() {
  if (!ctSelected) {
    alert('请先在列表中选中一个 CT 容器');
    return;
  }
  ctOpenConsole(ctSelected);
}

function ctOpenConsole(idOrName) {
  const c = ctInventory?.cts?.find(x => x.id === idOrName || x.name === idOrName) || { name: idOrName, state: 'unknown' };
  const name = c.name || idOrName;
  ctCurrentConsoleName = name;

  const modal = document.getElementById('vm-ct-console-modal');
  const titleEl = document.getElementById('ct-console-title');
  const badgeEl = document.getElementById('ct-console-badge');
  const metaEl = document.getElementById('ct-console-meta');
  const outEl = document.getElementById('ct-console-output');
  const promptEl = document.getElementById('ct-console-prompt');
  const inputEl = document.getElementById('ct-console-input');

  if (!modal || !outEl) return;

  const isRunning = c.state === 'running';
  titleEl.innerHTML = `CT 控制台 - <span style="color:#38bdf8;">${escapeHtml(name)}</span> (${escapeHtml(c.os || 'Linux')})`;
  badgeEl.className = isRunning ? 'ops-tag good' : 'ops-tag warn';
  badgeEl.textContent = isRunning ? '运行中' : (c.stateStr || '已停止');

  // Datastore & IP
  const ds = (c.rootfs && c.rootfs.includes('/mnt/vadata')) ? 'datastore-ssd' : ((c.rootfs && c.rootfs.includes('/mnt/raid10')) ? 'datastore-raid10' : 'datastore1');
  const ipStr = c.ips && c.ips.length ? c.ips.join(', ') : '未获取到 IP';
  metaEl.innerHTML = `<span class="ops-tag good" style="font-size:10px;">${escapeHtml(ds)}</span> <span style="color:#38bdf8;">${escapeHtml(ipStr)}</span>`;

  promptEl.textContent = `root@${escapeHtml(name)}:~#`;

  // Output header
  outEl.innerHTML = `
<div style="color:#60a5fa;margin-bottom:8px;font-weight:600;">
  ╭─────────────────────────────────────────────────────────────╮
  │   Proxmox VE / LXC Container Web Console                    │
  │   容器名称: ${name.padEnd(46)}│
  │   当前状态: ${(isRunning ? '运行中 (Running)' : '已停止 (Stopped)').padEnd(46)}│
  │   存储池: ${(ds + ' (' + (c.rootfs || '') + ')').padEnd(48)}│
  ╰─────────────────────────────────────────────────────────────╯
</div>`;

  if (!isRunning) {
    outEl.innerHTML += `
<div style="color:#f59e0b;padding:8px 0;display:flex;align-items:center;gap:10px;">
  <span><i class="fa-solid fa-triangle-exclamation"></i> 提示: 该 CT 容器当前处于停止状态。</span>
  <button type="button" class="ct-quick-cmd-btn" style="background:#0071e3;color:#fff;border-color:#0071e3;padding:4px 12px;font-weight:600;" onclick="ctConsoleStartContainer('${escapeHtml(name)}')">
    <i class="fa-solid fa-play"></i> 立即启动容器
  </button>
</div>`;
  }

  modal.style.display = 'flex';
  modal.removeAttribute('hidden');

  if (inputEl) {
    inputEl.value = '';
    setTimeout(() => inputEl.focus(), 150);
  }

  if (isRunning) {
    ctConsoleRunCmd('uname -a; uptime');
  }
}

async function ctConsoleStartContainer(name) {
  const outEl = document.getElementById('ct-console-output');
  if (outEl) outEl.innerHTML += `<div style="color:#38bdf8;">[系统] 正在启动容器 ${escapeHtml(name)}...</div>`;
  try {
    const res = await apiFetch('/api/vms/cts/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, action: 'start' })
    });
    const j = await res.json();
    if (!j.success) throw new Error(j.error || j.message);
    if (outEl) outEl.innerHTML += `<div style="color:#22c55e;">[系统] 容器启动成功！正在建立终端会话...</div>`;
    fetchCts();
    setTimeout(() => {
      ctOpenConsole(name);
    }, 1200);
  } catch (err) {
    if (outEl) outEl.innerHTML += `<div style="color:#ef4444;">[错误] 启动失败: ${escapeHtml(err.message)}</div>`;
  }
}

function vmCloseCtConsole() {
  const modal = document.getElementById('vm-ct-console-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('hidden', '');
  }
  ctCurrentConsoleName = null;
}

function ctConsoleClear() {
  const outEl = document.getElementById('ct-console-output');
  if (outEl) outEl.innerHTML = `<div style="color:#64748b;font-style:italic;">[终端屏幕已清空]</div>\n`;
}

let ctConsoleIsExpanded = false;
function ctConsoleToggleExpand() {
  const win = document.getElementById('ct-console-window');
  if (!win) return;
  ctConsoleIsExpanded = !ctConsoleIsExpanded;
  if (ctConsoleIsExpanded) {
    win.style.width = '98vw';
    win.style.height = '94vh';
    win.style.maxWidth = '98vw';
    win.style.maxHeight = '94vh';
  } else {
    win.style.width = '880px';
    win.style.height = '560px';
    win.style.maxWidth = '96vw';
    win.style.maxHeight = '88vh';
  }
}

async function ctConsoleRunCmd(cmd) {
  if (!ctCurrentConsoleName) return;
  const outEl = document.getElementById('ct-console-output');
  const inputEl = document.getElementById('ct-console-input');
  if (!outEl) return;

  const cleanCmd = (cmd || '').trim();
  if (!cleanCmd) return;

  if (!ctConsoleHistory.length || ctConsoleHistory[ctConsoleHistory.length - 1] !== cleanCmd) {
    ctConsoleHistory.push(cleanCmd);
  }
  ctConsoleHistoryIdx = ctConsoleHistory.length;

  outEl.innerHTML += `\n<div style="color:#38bdf8;font-weight:600;"><span style="color:#a855f7;">root@${escapeHtml(ctCurrentConsoleName)}</span>:<span style="color:#eab308;">~</span># <span style="color:#fff;">${escapeHtml(cleanCmd)}</span></div>`;
  outEl.scrollTop = outEl.scrollHeight;

  try {
    const res = await apiFetch('/api/vms/cts/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ctCurrentConsoleName, command: cleanCmd })
    });
    const j = await res.json();
    if (j.error) {
      outEl.innerHTML += `<div style="color:#ef4444;">${escapeHtml(j.error)}</div>`;
    } else {
      if (j.stdout) outEl.innerHTML += `<div style="color:#e2e8f0;">${escapeHtml(j.stdout)}</div>`;
      if (j.stderr) outEl.innerHTML += `<div style="color:#f59e0b;">${escapeHtml(j.stderr)}</div>`;
      if (!j.stdout && !j.stderr) outEl.innerHTML += `<div style="color:#64748b;font-style:italic;">(执行完成，无输出内容，返回码: ${j.exit_code || 0})</div>`;
    }
  } catch (e) {
    outEl.innerHTML += `<div style="color:#ef4444;">[网络执行异常] ${escapeHtml(e.message)}</div>`;
  }

  outEl.scrollTop = outEl.scrollHeight;
  if (inputEl) inputEl.focus();
}

function ctConsoleOnSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('ct-console-input');
  if (!input) return;
  const val = input.value;
  input.value = '';
  ctConsoleRunCmd(val);
}

function copyCtIp() {
  const c = ctInventory?.cts?.find(x => x.id === ctSelected || x.name === ctSelected);
  if (c && c.ips && c.ips.length) {
    navigator.clipboard?.writeText(c.ips[0]).then(() => {
      alert(`已复制 IP 地址: ${c.ips[0]}`);
    }).catch(() => {
      alert(`IP: ${c.ips[0]}`);
    });
  }
}

async function vmOpenCreateCtModal() {
  const modal = document.getElementById('vm-create-ct-modal');
  if (!modal) {
    console.error('[CT] vm-create-ct-modal not found in DOM');
    return;
  }

  // Auto assign next VMID (e.g. 100, 101, 102...)
  let maxVmid = 99;
  if (typeof ctInventory !== 'undefined' && ctInventory && ctInventory.cts) {
    ctInventory.cts.forEach(c => {
      const v = parseInt(c.vmid || c.id) || 0;
      if (v > maxVmid) maxVmid = v;
    });
  }
  const nextVmid = maxVmid + 1;

  const vmidInput = document.getElementById('ct-create-vmid');
  const nameInput = document.getElementById('ct-create-name');
  if (vmidInput) {
    vmidInput.value = nextVmid;
    vmidInput.oninput = () => {
      const v = vmidInput.value;
      if (v && nameInput) nameInput.value = `ct-${v}`;
    };
  }
  if (nameInput) {
    nameInput.value = `ct-${nextVmid}`;
  }

  // Default storage target to high-speed dedicated SSD
  const storageSelect = document.getElementById('ct-create-storage');
  if (storageSelect) {
    storageSelect.value = '/mnt/vadata/lxc-containers';
  }

  // Make sure local templates are populated
  if (!ctLocalTemplates || !ctLocalTemplates.length) {
    try {
      const r = await apiFetch('/api/vms/cts/local-templates');
      const j = await r.json();
      if (j.success && j.data) {
        ctLocalTemplates = j.data;
      }
    } catch (_) {}
  }
  updateCreateCtTemplateDropdown();

  // Initialize Create CT Multi-NIC cards
  ctRenderCreateNics([{ name: 'eth0', link: 'enp8s0f1', type: 'macvlan' }]);

  modal.style.display = 'flex';
}

function vmCloseCreateCtModal() {
  const modal = document.getElementById('vm-create-ct-modal');
  if (modal) modal.style.display = 'none';
}

async function vmSubmitCreateCt(e) {
  e.preventDefault();
  const btn = document.getElementById('ct-create-submit-btn');

  const vmid = document.getElementById('ct-create-vmid')?.value || '100';
  const name = document.getElementById('ct-create-name')?.value || `ct-${vmid}`;
  const templatePath = document.getElementById('ct-create-template-select')?.value;
  const storageTarget = document.getElementById('ct-create-storage')?.value || '/mnt/vadata/lxc-containers';
  const cores = parseInt(document.getElementById('ct-create-cores')?.value || '1');
  const memoryMiB = parseInt(document.getElementById('ct-create-ram')?.value || '512');
  const password = document.getElementById('ct-create-password')?.value || 'root123';
  const ip = document.getElementById('ct-create-ip')?.value?.trim();
  const gateway = document.getElementById('ct-create-gateway')?.value?.trim();

  // Collect Multi-NIC configurations from Create modal
  const nicCards = document.querySelectorAll('#ct-create-nics-container .ct-nic-card');
  const networks = [];
  nicCards.forEach((card, idx) => {
    const bridgeSelect = card.querySelector('.ct-nic-bridge-select');
    const macInput = card.querySelector('.ct-nic-mac-input');
    const selVal = bridgeSelect?.value || 'enp8s0f1';
    const isPhys = selVal.startsWith('phys:');
    const isMacvlan = (selVal === 'enp8s0f1' || selVal === 'macvlan');
    networks.push({
      index: idx,
      name: `eth${idx}`,
      link: isPhys ? selVal.replace('phys:', '') : selVal,
      type: isPhys ? 'phys' : (isMacvlan ? 'macvlan' : 'veth'),
      hwaddr: macInput?.value?.trim() || ''
    });
  });

  if (!templatePath) {
    alert('请先选择一个本地已下载的 CT 镜像模板！若未下载，请点击【CT 模板管理】从中科大镜像源一键拉取。');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在解压模板并安装配置...';
  }

  try {
    const r = await apiFetch('/api/vms/cts/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vmid, name, templatePath, storageTarget, cores, memoryMiB, networks, ip, gateway, password })
    });
    const j = await r.json();
    if (!j.success) throw Error(j.error || j.message);
    alert(j.message || `CT 容器 ${name} 创建成功！`);
    vmCloseCreateCtModal();
    ctSelected = name;
    fetchCts();
  } catch (err) {
    alert(`创建 CT 容器失败: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> 立即创建并配置';
    }
  }
}



// ─── PVE-STYLE CT TEMPLATE MANAGEMENT (USTC MIRROR) ───────────────────────────
let ctTemplateSources = null;
let ctLocalTemplates = [];
let ctDownloadTimer = null;
let ctSelectedOsFilter = 'all';
let ctSearchKeyword = '';
let ctCurrentActiveDownload = null;

async function fetchCtTemplates() {
  try {
    const [rSources, rLocal, rDl] = await Promise.all([
      apiFetch('/api/vms/cts/template-sources'),
      apiFetch('/api/vms/cts/local-templates'),
      apiFetch('/api/vms/cts/download-progress')
    ]);
    const jSources = await rSources.json();
    const jLocal = await rLocal.json();
    const jDl = await rDl.json();

    if (jSources.success) ctTemplateSources = jSources.data;
    if (jLocal.success) ctLocalTemplates = jLocal.data || [];
    if (jDl.success) ctCurrentActiveDownload = jDl.data;

    renderCtTemplateModal();
    updateCreateCtTemplateDropdown();
  } catch (e) {
    console.error('[CT Templates] fetch error:', e);
  }
}

function vmOpenCtTemplateModal() {
  const modal = document.getElementById('vm-ct-template-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  fetchCtTemplates();
  checkCtDownloadProgress();
}

function vmCloseCtTemplateModal() {
  const modal = document.getElementById('vm-ct-template-modal');
  if (modal) modal.style.display = 'none';
  if (ctDownloadTimer) {
    clearInterval(ctDownloadTimer);
    ctDownloadTimer = null;
  }
}

function switchCtTemplateTab(tab) {
  document.querySelectorAll('.ct-tmpl-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const pOnline = document.getElementById('ct-tmpl-panel-online');
  const pLocal = document.getElementById('ct-tmpl-panel-local');
  const tagsBar = document.getElementById('ct-tmpl-os-tags');

  if (pOnline) pOnline.style.display = (tab === 'online') ? 'block' : 'none';
  if (pLocal) pLocal.style.display = (tab === 'local') ? 'block' : 'none';
  if (tagsBar) tagsBar.style.display = (tab === 'online') ? 'flex' : 'none';
}

function vmFilterCtByOs(os) {
  ctSelectedOsFilter = os;
  document.querySelectorAll('#ct-tmpl-os-tags .ct-tag-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.os === os);
  });
  renderCtTemplateModal();
}

function vmFilterCtTemplates() {
  const input = document.getElementById('ct-tmpl-search-input');
  ctSearchKeyword = (input?.value || '').trim();
  renderCtTemplateModal();
}

function renderCtTemplateModal() {
  // 1. Populate Target Storage Select
  const storageSelect = document.getElementById('ct-tmpl-storage-select');
  if (storageSelect && ctTemplateSources?.storageTargets && !storageSelect.dataset.populated) {
    storageSelect.innerHTML = ctTemplateSources.storageTargets.map(st => {
      return `<option value="${escapeHtml(st.templateDir)}">${escapeHtml(st.name)} [${escapeHtml(st.templateDir)}]</option>`;
    }).join('');
    storageSelect.dataset.populated = 'true';
  }

  // 2. Filter Online Templates
  let remoteList = ctTemplateSources?.remoteTemplates || [];
  if (ctSelectedOsFilter && ctSelectedOsFilter !== 'all') {
    if (ctSelectedOsFilter === 'rhel') {
      remoteList = remoteList.filter(t => t.os === 'centos' || t.os === 'almalinux');
    } else {
      remoteList = remoteList.filter(t => t.os === ctSelectedOsFilter);
    }
  }

  if (ctSearchKeyword) {
    const kw = ctSearchKeyword.toLowerCase();
    remoteList = remoteList.filter(t => 
      t.name.toLowerCase().includes(kw) || 
      t.filename.toLowerCase().includes(kw) || 
      (t.desc && t.desc.toLowerCase().includes(kw))
    );
  }

  // 3. Render Online List
  const onlineContainer = document.getElementById('ct-tmpl-online-list');
  if (onlineContainer) {
    if (!remoteList.length) {
      onlineContainer.innerHTML = `
        <div style="text-align:center;padding:36px;color:var(--esxi-text-muted);">
          <i class="fa-solid fa-filter" style="font-size:32px;margin-bottom:8px;color:#64748b;"></i>
          <div style="font-size:13px;">未检索到匹配的模板</div>
          <div style="font-size:11.5px;margin-top:4px;">请尝试更换搜索关键字或清除筛选分类</div>
        </div>
      `;
    } else {
      const osStyles = {
        alpine: { icon: 'fa-mountain', color: '#00c0ef', bg: 'rgba(0,192,239,0.15)', brand: false },
        debian: { icon: 'fa-dharmachakra', color: '#d70a53', bg: 'rgba(215,10,83,0.15)', brand: false },
        ubuntu: { icon: 'fa-ubuntu', color: '#e95420', bg: 'rgba(233,84,32,0.15)', brand: true },
        centos: { icon: 'fa-centos', color: '#9333ea', bg: 'rgba(147,51,234,0.15)', brand: true },
        almalinux: { icon: 'fa-linux', color: '#0284c7', bg: 'rgba(2,132,199,0.15)', brand: false },
        archlinux: { icon: 'fa-linux', color: '#1793d1', bg: 'rgba(23,147,209,0.15)', brand: false }
      };

      onlineContainer.innerHTML = remoteList.map(t => {
        const isDownloaded = ctLocalTemplates.some(lt => lt.filename === t.filename);
        const isDownloading = ctCurrentActiveDownload?.active && ctCurrentActiveDownload?.filename === t.filename;
        const osStyle = osStyles[t.os] || { icon: 'fa-linux', color: '#00c0ef', bg: 'rgba(0,192,239,0.15)', brand: false };
        const iconClass = osStyle.brand ? `fa-brands ${osStyle.icon}` : `fa-solid ${osStyle.icon}`;

        let actionBtnHtml = '';
        if (isDownloading) {
          actionBtnHtml = `
            <button class="esxi-btn esxi-btn-primary esxi-btn-sm" disabled style="opacity:0.85;">
              <i class="fa-solid fa-spinner fa-spin"></i> 拉取中 ${ctCurrentActiveDownload.progress || 0}%
            </button>
          `;
        } else if (isDownloaded) {
          actionBtnHtml = `
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="ops-tag good" style="font-size:11px;padding:3px 8px;"><i class="fa-solid fa-check"></i> 本地已下载</span>
              <button class="esxi-btn esxi-btn-sm" onclick="vmSelectTemplateAndCreate('${escapeHtml(t.filename)}')">
                <i class="fa-solid fa-plus"></i> 创建 CT
              </button>
            </div>
          `;
        } else {
          actionBtnHtml = `
            <button class="esxi-btn esxi-btn-primary esxi-btn-sm" onclick="vmDownloadTemplate('${escapeHtml(t.filename)}')">
              <i class="fa-solid fa-cloud-arrow-down"></i> 一键拉取
            </button>
          `;
        }

        return `
          <div class="ct-tmpl-item-card">
            <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0;">
              <div style="width:36px;height:36px;background:${osStyle.bg};color:${osStyle.color};border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
                <i class="${iconClass}"></i>
              </div>
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <strong style="font-size:13px;color:var(--esxi-text-bright);">${escapeHtml(t.name)}</strong>
                  <span class="ops-tag" style="font-size:10px;padding:1px 6px;">amd64</span>
                  ${t.recommended ? '<span class="ops-tag good" style="font-size:10px;padding:1px 6px;">推荐首选</span>' : ''}
                  <span style="font-size:11.5px;color:#00c0ef;font-weight:600;margin-left:auto;margin-right:12px;">约 ${escapeHtml(t.sizeEstimate)}</span>
                </div>
                <div style="font-size:11.5px;color:var(--esxi-text-muted);margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <code style="background:rgba(0,0,0,0.25);padding:1px 5px;border-radius:3px;font-size:11px;color:var(--esxi-text);">${escapeHtml(t.filename)}</code>
                  <span>·</span>
                  <span>${escapeHtml(t.desc)}</span>
                </div>
              </div>
            </div>
            <div style="flex-shrink:0;margin-left:14px;">
              ${actionBtnHtml}
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 4. Render Local Templates
  const localContainer = document.getElementById('ct-tmpl-local-list');
  const localCountBadge = document.getElementById('ct-tmpl-local-count');
  if (localCountBadge) localCountBadge.textContent = ctLocalTemplates.length;

  if (localContainer) {
    if (!ctLocalTemplates.length) {
      localContainer.innerHTML = `
        <div style="text-align:center;padding:36px;color:var(--esxi-text-muted);">
          <i class="fa-solid fa-folder-open" style="font-size:36px;margin-bottom:10px;color:#64748b;"></i>
          <div style="font-size:13px;font-weight:600;">当前存储路径下暂无已下载的 CT 模板</div>
          <div style="font-size:11.5px;margin-top:4px;">请切换至【中科大镜像源 (在线下载)】选择 Alpine / Debian / Ubuntu 模板一键拉取。</div>
        </div>
      `;
    } else {
      localContainer.innerHTML = ctLocalTemplates.map(lt => {
        return `
          <div class="ct-tmpl-item-card">
            <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
              <div style="width:34px;height:34px;background:rgba(34,197,94,0.15);color:#22c55e;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
                <i class="fa-solid fa-file-zipper"></i>
              </div>
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <strong style="font-size:13px;color:var(--esxi-text-bright);">${escapeHtml(lt.filename)}</strong>
                  <span class="ops-tag good" style="font-size:10px;padding:1px 6px;">${escapeHtml(lt.datastore)}</span>
                  <span style="font-size:11px;color:#22c55e;font-weight:600;">${escapeHtml(lt.sizeHuman)}</span>
                </div>
                <div style="font-size:11.5px;color:var(--esxi-text-muted);margin-top:3px;">
                  存放路径: <code>${escapeHtml(lt.path)}</code> · 下载时间: ${escapeHtml(lt.mtime)}
                </div>
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;margin-left:12px;">
              <button class="esxi-btn esxi-btn-primary esxi-btn-sm" onclick="vmSelectTemplateAndCreate('${escapeHtml(lt.filename)}', '${escapeHtml(lt.path)}')">
                <i class="fa-solid fa-plus"></i> 以此创建 CT
              </button>
              <button class="esxi-btn esxi-btn-danger esxi-btn-sm" onclick="vmDeleteTemplate('${escapeHtml(lt.path)}')">
                <i class="fa-solid fa-trash"></i> 删除
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

async function vmDownloadTemplate(filename) {
  const targetDir = document.getElementById('ct-tmpl-storage-select')?.value || '/mnt/raid10/template/cache';
  const mirror = document.getElementById('ct-tmpl-mirror-select')?.value || 'ustc';

  try {
    const r = await apiFetch('/api/vms/cts/download-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, targetDir, mirror })
    });
    const j = await r.json();
    if (!j.success) throw Error(j.error);

    // Auto expand Recent Tasks drawer
    esxiToggleTasksDrawer(true);
    esxiFetchRecentTasks();
    checkCtDownloadProgress();
  } catch (e) {
    alert('发起下载失败: ' + e.message);
  }
}

async function vmDeleteTemplate(path) {
  if (!confirm(`确定要从存储中删除模板 ${path} 吗？`)) return;
  try {
    const r = await apiFetch('/api/vms/cts/delete-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    const j = await r.json();
    if (!j.success) throw Error(j.error);
    fetchCtTemplates();
    esxiFetchRecentTasks();
  } catch (e) {
    alert('删除模板失败: ' + e.message);
  }
}

function checkCtDownloadProgress() {
  if (ctDownloadTimer) {
    clearInterval(ctDownloadTimer);
    ctDownloadTimer = null;
  }

  const poll = async () => {
    try {
      const r = await apiFetch('/api/vms/cts/download-progress');
      const j = await r.json();
      const card = document.getElementById('ct-tmpl-download-card');
      ctCurrentActiveDownload = j.data;

      // If no active download, stop polling immediately!
      if (!j.data || !j.data.active) {
        if (card) card.style.display = 'none';
        if (ctDownloadTimer) {
          clearInterval(ctDownloadTimer);
          ctDownloadTimer = null;
        }
        if (j.data?.success) {
          fetchCtTemplates();
        }
        return;
      }

      // If downloading is actively running
      if (card) {
        card.style.display = 'block';
        const titleEl = document.getElementById('ct-tmpl-dl-title');
        const bytesEl = document.getElementById('ct-tmpl-dl-bytes');
        const speedEl = document.getElementById('ct-tmpl-dl-speed');
        const pctEl = document.getElementById('ct-tmpl-dl-percent');
        const fillEl = document.getElementById('ct-tmpl-dl-fill');
        const pathEl = document.getElementById('ct-tmpl-dl-path');

        if (titleEl) titleEl.textContent = `正在从中科大源拉取 CT 模板: ${j.data.filename}`;
        if (bytesEl) bytesEl.textContent = `${j.data.downloadedMB || '0.0'} MB / ${j.data.totalMB ? j.data.totalMB + ' MB' : '计算中'}`;
        if (speedEl) speedEl.innerHTML = `<i class="fa-solid fa-bolt"></i> ${j.data.speed || '—'}`;
        if (pctEl) pctEl.textContent = `${j.data.progress || 0}%`;
        if (fillEl) fillEl.style.width = `${j.data.progress || 0}%`;
        if (pathEl) pathEl.textContent = `目标存储目录: ${j.data.targetDir}`;
      }

      // Only refresh tasks if user is NOT currently typing into an input
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        esxiFetchRecentTasks();
      }
    } catch (_) {
      if (ctDownloadTimer) {
        clearInterval(ctDownloadTimer);
        ctDownloadTimer = null;
      }
    }
  };

  poll();
  // Only repeat if active download is present
  ctDownloadTimer = setInterval(poll, 1500);
}

function updateCreateCtTemplateDropdown() {
  const select = document.getElementById('ct-create-template-select');
  if (!select) return;

  const modal = document.getElementById('vm-create-ct-modal');
  const isModalOpen = modal && modal.style.display === 'flex';
  // If modal is open and user already has a valid selection, do not wipe it
  if (isModalOpen && select.options.length > 1 && select.value) {
    return;
  }

  const prevVal = select.value;
  if (!ctLocalTemplates.length) {
    select.innerHTML = '<option value="">(暂无本地模板 · 请先点击右侧按钮拉取)</option>';
  } else {
    select.innerHTML = '<option value="">(请选择已下载的 CT 镜像模板)</option>' + ctLocalTemplates.map(lt => {
      return `<option value="${escapeHtml(lt.path)}">[${escapeHtml(lt.datastore)}] ${escapeHtml(lt.filename)} (${escapeHtml(lt.sizeHuman)})</option>`;
    }).join('');
  }
  if (prevVal) select.value = prevVal;
  vmOnCreateTemplateChanged();
}

function vmOnCreateTemplateChanged() {
  const select = document.getElementById('ct-create-template-select');
  const preview = document.getElementById('ct-selected-tmpl-preview');
  const storageSelect = document.getElementById('ct-create-storage');
  if (!select || !preview) return;

  const val = select.value;
  if (!val) {
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }

  const tmpl = ctLocalTemplates.find(x => x.path === val);
  if (!tmpl) {
    preview.style.display = 'none';
    return;
  }

  // Auto-sync storage target with template datastore!
  if (storageSelect) {
    if (tmpl.datastore === 'datastore-ssd' || (val && val.includes('/mnt/vadata'))) {
      storageSelect.value = '/mnt/vadata/lxc-containers';
    } else if (tmpl.datastore === 'datastore-raid10' || (val && val.includes('/mnt/raid10'))) {
      storageSelect.value = '/mnt/raid10/lxc-containers';
    } else if (tmpl.datastore === 'datastore1' || (val && val.includes('/var/lib'))) {
      storageSelect.value = '/var/lib/lxc';
    }
  }

  const currentStoreText = storageSelect?.options[storageSelect?.selectedIndex]?.text || storageSelect?.value || '已选存储池';

  preview.style.display = 'block';
  preview.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:8px;">
        <i class="fa-solid fa-circle-check" style="color:#22c55e;"></i>
        <span>已选用: <strong>${escapeHtml(tmpl.filename)}</strong></span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <span class="ops-tag good" style="font-size:10px;">${escapeHtml(tmpl.datastore)}</span>
        <span style="font-size:11px;color:#22c55e;font-weight:600;">${escapeHtml(tmpl.sizeHuman)}</span>
      </div>
    </div>
    <div style="margin-top:6px;font-size:11.5px;color:rgba(255,255,255,0.7);display:flex;align-items:center;gap:6px;">
      <i class="fa-solid fa-arrow-right-arrow-left" style="color:#0071e3;"></i>
      <span>容器存放存储池已自动联动为: <strong style="color:#38bdf8;">${escapeHtml(currentStoreText)}</strong></span>
    </div>
  `;
}

function vmSelectTemplateAndCreate(filename, path) {
  vmCloseCtTemplateModal();
  vmOpenCreateCtModal();
  setTimeout(() => {
    const select = document.getElementById('ct-create-template-select');
    if (select) {
      if (path) {
        select.value = path;
      } else if (filename && ctLocalTemplates) {
        const found = ctLocalTemplates.find(x => x.filename === filename);
        if (found) select.value = found.path;
      }
      vmOnCreateTemplateChanged();
    }
  }, 150);
}

// Global exports
window.vmOpenCreateCtModal = vmOpenCreateCtModal;
window.vmCloseCreateCtModal = vmCloseCreateCtModal;
window.vmSubmitCreateCt = vmSubmitCreateCt;
window.vmOpenCtTemplateModal = vmOpenCtTemplateModal;
window.vmCloseCtTemplateModal = vmCloseCtTemplateModal;
window.switchCtTemplateTab = switchCtTemplateTab;
window.vmFilterCtByOs = vmFilterCtByOs;
window.vmFilterCtTemplates = vmFilterCtTemplates;
window.vmDownloadTemplate = vmDownloadTemplate;
window.vmDeleteTemplate = vmDeleteTemplate;
window.vmSelectTemplateAndCreate = vmSelectTemplateAndCreate;
window.vmOnCreateTemplateChanged = vmOnCreateTemplateChanged;
window.ctOpenConsole = ctOpenConsole;
window.ctOpenEditSettingsModal = ctOpenEditSettingsModal;
window.ctCloseEditSettingsModal = ctCloseEditSettingsModal;
window.ctSubmitEditSettings = ctSubmitEditSettings;
window.ctGenerateRandomMac = ctGenerateRandomMac;
window.ctOpenSelectedConsole = ctOpenSelectedConsole;
window.vmCloseCtConsole = vmCloseCtConsole;
window.ctConsoleClear = ctConsoleClear;
window.ctConsoleToggleExpand = ctConsoleToggleExpand;
window.ctConsoleRunCmd = ctConsoleRunCmd;
window.ctConsoleOnSubmit = ctConsoleOnSubmit;
window.ctConsoleStartContainer = ctConsoleStartContainer;
window.esxiToggleTasksDrawer = esxiToggleTasksDrawer;
window.esxiFetchRecentTasks = esxiFetchRecentTasks;

document.addEventListener('keydown', (e) => {
  const input = document.getElementById('ct-console-input');
  if (!input || document.activeElement !== input) return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (ctConsoleHistoryIdx > 0) {
      ctConsoleHistoryIdx--;
      input.value = ctConsoleHistory[ctConsoleHistoryIdx] || '';
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (ctConsoleHistoryIdx < ctConsoleHistory.length - 1) {
      ctConsoleHistoryIdx++;
      input.value = ctConsoleHistory[ctConsoleHistoryIdx] || '';
    } else {
      ctConsoleHistoryIdx = ctConsoleHistory.length;
      input.value = '';
    }
  }
});
