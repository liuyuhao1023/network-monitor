#!/usr/bin/env python3
"""
ct-helper.py - Proxmox VE (PVE) Style CT Container (LXC) Management Helper
Supports:
- Container lifecycle (list, start, stop, kill, restart, destroy, info)
- Template repository from USTC mirror (中科大源)
- Manual download of CT templates to selected datastore/path
- Creating CT containers extracted directly from downloaded templates
"""

import sys
import os
import json
import shutil
import subprocess
import re
import time
import glob
import urllib.request
import threading

LXC_DIR = "/var/lib/lxc"
DOWNLOAD_STATUS_FILE = "/tmp/ct-template-download.json"

MIRRORS = [
    {
        "id": "ustc",
        "name": "中科大源 (USTC Mirror · 国内推荐极速)",
        "baseUrl": "https://mirrors.ustc.edu.cn/proxmox/images/system/"
    },
    {
        "id": "tsinghua",
        "name": "清华大学源 (TUNA Mirror)",
        "baseUrl": "https://mirrors.tuna.tsinghua.edu.cn/proxmox/images/system/"
    },
    {
        "id": "official",
        "name": "Proxmox 官方源 (Global)",
        "baseUrl": "http://download.proxmox.com/images/system/"
    }
]

STORAGE_TARGETS = [
    {
        "id": "datastore-raid10",
        "name": "datastore-raid10 (大容量阵列 · 推荐)",
        "templateDir": "/mnt/raid10/template/cache",
        "containerDir": "/mnt/raid10/lxc-containers"
    },
    {
        "id": "datastore-ssd",
        "name": "datastore-ssd (第二高速 SSD)",
        "templateDir": "/mnt/vadata/template/cache",
        "containerDir": "/mnt/vadata/lxc-containers"
    },
    {
        "id": "datastore1",
        "name": "datastore1 (系统高速 SSD)",
        "templateDir": "/var/lib/vz/template/cache",
        "containerDir": "/var/lib/lxc"
    }
]

# Curated popular PVE templates available on USTC mirror
REMOTE_TEMPLATES = [
    {
        "filename": "alpine-3.21-default_20241217_amd64.tar.xz",
        "os": "alpine",
        "version": "3.21",
        "name": "Alpine Linux 3.21 (超轻量 · 秒开首选)",
        "sizeEstimate": "3.1 MB",
        "desc": "极度精简，内存占用低至 15MB，微服务与轻量网络应用首选",
        "recommended": True
    },
    {
        "filename": "alpine-3.20-default_20240908_amd64.tar.xz",
        "os": "alpine",
        "version": "3.20",
        "name": "Alpine Linux 3.20 (稳定版)",
        "sizeEstimate": "3.1 MB",
        "desc": "轻量级高稳定性容器镜像",
        "recommended": False
    },
    {
        "filename": "debian-12-standard_12.12-1_amd64.tar.zst",
        "os": "debian",
        "version": "12",
        "name": "Debian 12 (Bookworm · 稳定通用标准版)",
        "sizeEstimate": "110 MB",
        "desc": "企业级极其稳定，官方软件仓库最为丰富，通用首选",
        "recommended": True
    },
    {
        "filename": "debian-11-standard_11.7-1_amd64.tar.zst",
        "os": "debian",
        "version": "11",
        "name": "Debian 11 (Bullseye)",
        "sizeEstimate": "105 MB",
        "desc": "经典稳定发行版",
        "recommended": False
    },
    {
        "filename": "ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
        "os": "ubuntu",
        "version": "24.04 LTS",
        "name": "Ubuntu 24.04 LTS (Noble · 现代开发套件最全)",
        "sizeEstimate": "120 MB",
        "desc": "最新长期支持版，具备最前沿开发运维库与完整 systemd 兼容",
        "recommended": True
    },
    {
        "filename": "ubuntu-22.04-standard_22.04-1_amd64.tar.zst",
        "os": "ubuntu",
        "version": "22.04 LTS",
        "name": "Ubuntu 22.04 LTS (Jammy · 广泛兼容)",
        "sizeEstimate": "115 MB",
        "desc": "广泛成熟的生产环境镜像",
        "recommended": False
    },
    {
        "filename": "centos-9-stream-default_20240828_amd64.tar.xz",
        "os": "centos",
        "version": "9-stream",
        "name": "CentOS 9 Stream (RHEL 兼容)",
        "sizeEstimate": "90 MB",
        "desc": "RedHat / Enterprise Linux 上游标准兼容系统",
        "recommended": False
    },
    {
        "filename": "almalinux-9-default_20240911_amd64.tar.xz",
        "os": "almalinux",
        "version": "9",
        "name": "AlmaLinux 9 (1:1 RHEL 二进制兼容)",
        "sizeEstimate": "95 MB",
        "desc": "100% 兼容 RHEL 9，适合企业级服务端软件",
        "recommended": False
    },
    {
        "filename": "archlinux-base_20240911-1_amd64.tar.zst",
        "os": "archlinux",
        "version": "Rolling",
        "name": "Arch Linux Base (滚动更新前沿)",
        "sizeEstimate": "140 MB",
        "desc": "滚动更新，包含 Pacman 包管理器与最新内核模块",
        "recommended": False
    }
]

def run_cmd(cmd, timeout=60):
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return res.returncode, res.stdout.strip(), res.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except Exception as e:
        return -1, "", str(e)

def check_lxc_installed():
    lxc_ls = shutil.which("lxc-ls")
    lxc_info = shutil.which("lxc-info")
    installed = bool(lxc_ls and lxc_info)
    version = None
    if installed:
        rc, out, _ = run_cmd(["lxc-info", "--version"])
        if rc == 0 and out:
            version = out.split("\n")[0].strip()
    return {
        "installed": installed,
        "version": version
    }

def get_template_sources():
    return {
        "mirrors": MIRRORS,
        "currentMirror": "ustc",
        "storageTargets": STORAGE_TARGETS,
        "remoteTemplates": REMOTE_TEMPLATES
    }

def get_local_templates():
    items = []
    # Check all configured template directories
    search_dirs = [
        ("/mnt/raid10/template/cache", "datastore-raid10"),
        ("/mnt/vadata/template/cache", "datastore-ssd"),
        ("/var/lib/vz/template/cache", "datastore1"),
        ("/var/lib/lxc/template/cache", "datastore1")
    ]
    seen_paths = set()
    for d, ds in search_dirs:
        if not os.path.isdir(d):
            continue
        try:
            for fname in os.listdir(d):
                if not (fname.endswith(".tar.xz") or fname.endswith(".tar.zst") or fname.endswith(".tar.gz")):
                    continue
                fpath = os.path.join(d, fname)
                if fpath in seen_paths:
                    continue
                seen_paths.add(fpath)
                st = os.stat(fpath)
                size_mb = round(st.st_size / (1024 * 1024), 2)
                size_str = f"{size_mb} MB" if size_mb < 1024 else f"{round(size_mb/1024, 2)} GB"
                mtime_str = time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))
                
                os_name = "Linux"
                if "alpine" in fname.lower(): os_name = "Alpine Linux"
                elif "debian" in fname.lower(): os_name = "Debian"
                elif "ubuntu" in fname.lower(): os_name = "Ubuntu"
                elif "centos" in fname.lower(): os_name = "CentOS"
                elif "alma" in fname.lower(): os_name = "AlmaLinux"
                elif "arch" in fname.lower(): os_name = "Arch Linux"

                items.append({
                    "filename": fname,
                    "path": fpath,
                    "sizeBytes": st.st_size,
                    "sizeHuman": size_str,
                    "datastore": ds,
                    "dir": d,
                    "os": os_name,
                    "mtime": mtime_str
                })
        except Exception:
            pass
    return items

def get_download_status():
    if os.path.exists(DOWNLOAD_STATUS_FILE):
        try:
            with open(DOWNLOAD_STATUS_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {"active": False}

def set_download_status(data):
    try:
        with open(DOWNLOAD_STATUS_FILE, "w") as f:
            json.dump(data, f)
    except Exception:
        pass

def download_template_bg(filename, target_dir, mirror_url):
    set_download_status({
        "active": True,
        "filename": filename,
        "targetDir": target_dir,
        "percent": 5,
        "status": "正在连接中科大镜像源下载...",
        "startTime": time.time()
    })
    try:
        os.makedirs(target_dir, exist_ok=True)
        dest_path = os.path.join(target_dir, filename)
        part_path = dest_path + ".part"
        url = mirror_url.rstrip("/") + "/" + filename

        # Download with curl
        cmd = ["curl", "-f", "-L", "-k", "-o", part_path, url]
        rc, out, err = run_cmd(cmd, timeout=600)
        if rc != 0:
            set_download_status({
                "active": False,
                "error": f"下载失败: {err or out}",
                "filename": filename
            })
            if os.path.exists(part_path):
                try: os.remove(part_path)
                except: pass
            return

        if os.path.exists(part_path):
            os.rename(part_path, dest_path)

        set_download_status({
            "active": False,
            "success": True,
            "filename": filename,
            "destPath": dest_path,
            "message": f"模板 {filename} 下载成功！"
        })
    except Exception as e:
        set_download_status({
            "active": False,
            "error": str(e),
            "filename": filename
        })

def start_download_template(params):
    filename = params.get("filename")
    target_dir = params.get("targetDir") or "/mnt/raid10/template/cache"
    mirror_id = params.get("mirror") or "ustc"

    if not filename:
        return {"success": False, "error": "缺少文件名"}

    mirror = next((m for m in MIRRORS if m["id"] == mirror_id), MIRRORS[0])
    base_url = mirror["baseUrl"]

    cur = get_download_status()
    if cur.get("active"):
        return {"success": False, "error": f"当前已有正在进行的下载任务: {cur.get('filename')}，请等待完成"}

    # Start download thread
    t = threading.Thread(target=download_template_bg, args=(filename, target_dir, base_url), daemon=True)
    t.start()
    return {"success": True, "message": f"已从中科大源开始拉取模板 {filename} 至 {target_dir}"}

def delete_template(path):
    if not path or not os.path.exists(path):
        return {"success": False, "error": "模板文件不存在"}
    try:
        os.remove(path)
        return {"success": True, "message": "模板已删除"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def get_host_network_interfaces():
    """Dynamically scan all physical and virtual network interfaces on host,
    detecting carrier status, link speed, and container assignments without hardcoding."""
    phys_used = {}
    if os.path.isdir(LXC_DIR):
        for ct in os.listdir(LXC_DIR):
            cfg = os.path.join(LXC_DIR, ct, "config")
            if not os.path.exists(cfg):
                continue
            cur_type = None
            try:
                with open(cfg, "r", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            k, v = [x.strip() for x in line.split("=", 1)]
                            if k.endswith(".type"):
                                cur_type = v
                            elif k.endswith(".link") and cur_type == "phys":
                                phys_used[v] = ct
            except Exception:
                pass

    interfaces = []
    seen = set()

    # 1. From host /sys/class/net
    net_dir = "/sys/class/net"
    if os.path.isdir(net_dir):
        for name in sorted(os.listdir(net_dir)):
            if name == "lo" or name.startswith("macvtap") or name.startswith("veth"):
                continue
            seen.add(name)
            real_path = os.path.realpath(os.path.join(net_dir, name))
            is_virtual = "/devices/virtual/net/" in real_path

            carrier = False
            car_path = os.path.join(net_dir, name, "carrier")
            if os.path.exists(car_path):
                try:
                    carrier = (open(car_path).read().strip() == "1")
                except:
                    pass

            speed = ""
            sp_path = os.path.join(net_dir, name, "speed")
            if os.path.exists(sp_path):
                try:
                    s = open(sp_path).read().strip()
                    if s and s != "-1":
                        speed = f"{int(s)//1000}G" if int(s) >= 1000 else f"{s}M"
                except:
                    pass

            mac = ""
            mac_path = os.path.join(net_dir, name, "address")
            if os.path.exists(mac_path):
                try:
                    mac = open(mac_path).read().strip()
                except:
                    pass

            is_bridge = os.path.exists(os.path.join(net_dir, name, "bridge")) or name in ("lxcbr0", "virbr0")
            is_primary = (name == "enp8s0f1")

            interfaces.append({
                "name": name,
                "isVirtual": is_virtual,
                "isBridge": is_bridge,
                "isPrimary": is_primary,
                "carrier": carrier,
                "speed": speed,
                "mac": mac,
                "inUseBy": phys_used.get(name)
            })

    # 2. Add any physical interfaces currently assigned inside a container (so not visible in host netns)
    for p_name, ct in phys_used.items():
        if p_name not in seen:
            interfaces.append({
                "name": p_name,
                "isVirtual": False,
                "isBridge": False,
                "isPrimary": False,
                "carrier": True,
                "speed": "10G",
                "mac": "",
                "inUseBy": ct
            })

    # Sort: Primary first, then physical interfaces, then bridges
    def sort_key(item):
        if item["isPrimary"]:
            return (0, item["name"])
        if not item["isVirtual"]:
            return (1, item["name"])
        return (2, item["name"])

    interfaces.sort(key=sort_key)
    return interfaces

def parse_container_config(config_path):
    conf = {
        "network": [],
        "memory_limit_bytes": 0,
        "cpus": None,
        "autostart": False,
        "arch": "x86_64",
        "rootfs": None
    }
    if not os.path.exists(config_path):
        return conf

    nets_by_idx = {}
    try:
        with open(config_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = [x.strip() for x in line.split("=", 1)]
                    if key.startswith("lxc.net."):
                        parts = key.split(".")
                        # Format: lxc.net.<idx>.<prop> or legacy lxc.net.<prop>
                        if len(parts) >= 4 and parts[2].isdigit():
                            idx = int(parts[2])
                            prop = ".".join(parts[3:])
                            if idx not in nets_by_idx:
                                nets_by_idx[idx] = {"index": idx}
                            nets_by_idx[idx][prop] = val
                        elif len(parts) == 3:
                            prop = parts[2]
                            if 0 not in nets_by_idx:
                                nets_by_idx[0] = {"index": 0}
                            nets_by_idx[0][prop] = val
                    elif key in ("lxc.cgroup2.memory.max", "lxc.cgroup.memory.limit_in_bytes"):
                        try:
                            conf["memory_limit_bytes"] = int(val)
                        except:
                            pass
                    elif key in ("lxc.cgroup2.cpuset.cpus", "lxc.cgroup.cpuset.cpus"):
                        conf["cpus"] = val
                    elif key == "lxc.start.auto":
                        conf["autostart"] = (val == "1")
                    elif key == "lxc.arch":
                        conf["arch"] = val
                    elif key == "lxc.rootfs.path":
                        conf["rootfs"] = val
        if nets_by_idx:
            conf["network"] = [nets_by_idx[i] for i in sorted(nets_by_idx.keys())]
    except Exception:
        pass
    return conf

def get_os_info(rootfs_path):
    if not rootfs_path:
        return "Linux Container"
    if rootfs_path.startswith("dir:"):
        rootfs_path = rootfs_path[4:]
    
    os_release = os.path.join(rootfs_path, "etc/os-release")
    if os.path.exists(os_release):
        try:
            with open(os_release, "r") as f:
                lines = f.read()
                m = re.search(r'PRETTY_NAME="([^"]+)"', lines) or re.search(r'PRETTY_NAME=([^\n]+)', lines)
                if m:
                    return m.group(1).replace('"', '')
        except:
            pass

    issue = os.path.join(rootfs_path, "etc/issue")
    if os.path.exists(issue):
        try:
            with open(issue, "r") as f:
                first = f.readline().strip()
                if first:
                    return first
        except:
            pass
    return "Linux Container"

def list_containers():
    status = check_lxc_installed()
    if not status["installed"]:
        return {
            "installed": False,
            "version": None,
            "cts": [],
            "sources": get_template_sources(),
            "localTemplates": get_local_templates(),
            "summary": {"total": 0, "running": 0, "stopped": 0}
        }

    cts = []
    if os.path.isdir(LXC_DIR):
        for name in sorted(os.listdir(LXC_DIR)):
            cfg = os.path.join(LXC_DIR, name, "config")
            if not os.path.exists(cfg):
                continue

            conf = parse_container_config(cfg)
            
            # Query lxc-info
            rc, out, _ = run_cmd(["lxc-info", "-n", name])
            info_dict = {}
            ips = []
            if rc == 0:
                for l in out.split("\n"):
                    if ":" in l:
                        k, v = [x.strip() for x in l.split(":", 1)]
                        info_dict[k.lower()] = v
                        if k.lower() == "ip":
                            if v and not v.startswith("127."):
                                ips.append(v)

            state_str = info_dict.get("state", "STOPPED").upper()
            state_code = 1 if state_str == "RUNNING" else (3 if state_str == "FROZEN" else 5)
            pid = info_dict.get("pid", "-")
            
            mem_used_bytes = 0
            mem_str = info_dict.get("memory use", "")
            if mem_str:
                parts = mem_str.split()
                if len(parts) >= 2:
                    val = float(parts[0])
                    unit = parts[1].lower()
                    if "k" in unit: mem_used_bytes = int(val * 1024)
                    elif "m" in unit: mem_used_bytes = int(val * 1024 * 1024)
                    elif "g" in unit: mem_used_bytes = int(val * 1024 * 1024 * 1024)
                elif mem_str.isdigit():
                    mem_used_bytes = int(mem_str)

            cpu_use = info_dict.get("cpu use", "-")
            rootfs_path = conf.get("rootfs") or os.path.join(LXC_DIR, name, "rootfs")
            if rootfs_path.startswith("dir:"):
                rootfs_path = rootfs_path[4:]
            
            os_name = get_os_info(rootfs_path)
            
            # Parse numeric VMID
            vmid = None
            vmid_f = os.path.join(LXC_DIR, name, "vmid")
            if os.path.exists(vmid_f):
                try: vmid = int(open(vmid_f).read().strip())
                except: pass
            if not vmid:
                m = re.search(r"(\d+)", name)
                if m:
                    vmid = int(m.group(1))
                else:
                    vmid = 100 + (abs(hash(name)) % 899)

            static_ip = ""
            gateway = "192.168.1.1"
            np_file = os.path.join(rootfs_path, "etc", "netplan", "10-lxc.yaml")
            if os.path.exists(np_file):
                try:
                    txt = open(np_file).read()
                    eth0_section = ""
                    if "eth0:" in txt:
                        parts = txt.split("eth0:", 1)[1]
                        eth0_section = re.split(r"\n\s*(?:eth\d+|enp\w+):", parts)[0]
                    if "addresses:" in eth0_section:
                        m_ip = re.search(r"-\s*([0-9\.\/]+)", eth0_section)
                        if m_ip: static_ip = m_ip.group(1)
                    elif "dhcp4: true" in eth0_section:
                        static_ip = "" 
                    m_gw = re.search(r"via:\s*([0-9\.]+)", txt)
                    if m_gw: gateway = m_gw.group(1)
                except Exception:
                    pass

            cts.append({
                "id": name,
                "vmid": vmid,
                "name": name,
                "state": state_code,
                "stateStr": state_str,
                "pid": pid,
                "ips": ips,
                "staticIp": static_ip,
                "gateway": gateway,
                "cpuAllocation": conf.get("cpus") or "全部核心共享",
                "cpuUse": cpu_use,
                "memoryLimitMiB": int(conf["memory_limit_bytes"] / 1024 / 1024) if conf["memory_limit_bytes"] > 0 else 0,
                "memoryUsedMiB": int(mem_used_bytes / 1024 / 1024) if mem_used_bytes > 0 else 0,
                "autostart": conf.get("autostart", False),
                "arch": conf.get("arch", "x86_64"),
                "network": conf.get("network", []),
                "os": os_name,
                "rootfs": rootfs_path
            })

    total = len(cts)
    running = sum(1 for c in cts if c["state"] == 1)
    stopped = total - running

    if running > 0:
        sync_macvlan_routes()

    return {
        "installed": True,
        "version": status["version"],
        "cts": cts,
        "hostInterfaces": get_host_network_interfaces(),
        "sources": get_template_sources(),
        "localTemplates": get_local_templates(),
        "summary": {
            "total": total,
            "running": running,
            "stopped": stopped
        }
    }

def sync_macvlan_routes():
    """Ensure host routing always gives physical NIC enp8s0f1 absolute priority,
    while creating precise /32 routes to macvlan-host for active CT containers."""
    try:
        rc, _, _ = run_cmd(["ip", "link", "show", "macvlan-host"])
        if rc != 0:
            return
        rc, out, _ = run_cmd(["lxc-ls", "-f"])
        if rc == 0 and out:
            for line in out.splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "RUNNING":
                    for p in re.findall(r"192\.168\.1\.\d+", line):
                        if p not in ("192.168.1.241", "192.168.1.240", "192.168.1.1"):
                            run_cmd(["ip", "route", "replace", f"{p}/32", "dev", "macvlan-host"])
    except Exception:
        pass

def action_container(name, action):
    if not name:
        return {"success": False, "error": "缺少容器名称或 ID"}

    if action == "start":
        rc, out, err = run_cmd(["lxc-start", "-n", name, "-d"])
        if rc != 0:
            return {"success": False, "error": f"启动容器失败: {err or out}"}
        sync_macvlan_routes()
        return {"success": True, "message": f"容器 {name} 已启动"}

    elif action in ("stop", "shutdown"):
        rc, out, err = run_cmd(["lxc-stop", "-n", name, "-t", "10"])
        if rc != 0:
            return {"success": False, "error": f"停止容器失败: {err or out}"}
        return {"success": True, "message": f"容器 {name} 已停止"}

    elif action in ("kill", "force-stop"):
        rc, out, err = run_cmd(["lxc-stop", "-n", name, "-k"])
        if rc != 0:
            return {"success": False, "error": f"强制杀死容器失败: {err or out}"}
        return {"success": True, "message": f"容器 {name} 已强制终止"}

    elif action == "restart":
        run_cmd(["lxc-stop", "-n", name, "-t", "10"])
        time.sleep(1)
        rc, out, err = run_cmd(["lxc-start", "-n", name, "-d"])
        if rc != 0:
            return {"success": False, "error": f"重启容器失败: {err or out}"}
        sync_macvlan_routes()
        return {"success": True, "message": f"容器 {name} 已重启"}

    elif action == "destroy":
        run_cmd(["lxc-stop", "-n", name, "-k"])
        time.sleep(0.5)
        # Check if symlink
        lxc_link = os.path.join(LXC_DIR, name)
        real_target = None
        if os.path.islink(lxc_link):
            try:
                real_target = os.readlink(lxc_link)
            except:
                pass
        
        rc, out, err = run_cmd(["lxc-destroy", "-n", name, "-f"])
        if real_target and os.path.isdir(real_target):
            try: shutil.rmtree(real_target)
            except: pass
        if os.path.islink(lxc_link) or os.path.exists(lxc_link):
            try: os.remove(lxc_link)
            except: pass

        return {"success": True, "message": f"容器 {name} 已彻底销毁"}

    return {"success": False, "error": f"未知操作: {action}"}


def configure_container_network(rootfs_dir, ip_val, gateway, networks, is_running=False, name=""):
    """
    Configures DHCP or Static IP and ensures systemd-networkd & systemd-resolved
    are permanently enabled in multi-user.target.wants so CT containers always acquire
    an IP on boot.
    """
    if not os.path.isdir(rootfs_dir):
        return

    ip_str = str(ip_val or "").strip()
    gw_str = str(gateway or "192.168.1.1").strip()
    is_static = bool(ip_str and ip_str.lower() != "dhcp")

    # 1. Ubuntu / Debian systemd netplan
    np_dir = os.path.join(rootfs_dir, "etc", "netplan")
    if os.path.isdir(np_dir):
        if is_static:
            cidr = ip_str if "/" in ip_str else f"{ip_str}/24"
            eth0_cfg = f"""    eth0:
      dhcp4: false
      dhcp6: false
      addresses:
        - {cidr}
      routes:
        - to: default
          via: {gw_str}
          metric: 1000
      nameservers:
        addresses:
          - {gw_str}
          - 223.5.5.5
"""
        else:
            eth0_cfg = "    eth0:\n      dhcp4: true\n"

        extra_eths = ""
        for idx in range(1, len(networks)):
            nname = networks[idx].get("name") or f"eth{idx}"
            n_ip = str(networks[idx].get("ip") or "").strip()
            if n_ip and n_ip.lower() != "dhcp":
                cidr = n_ip if "/" in n_ip else f"{n_ip}/24"
                extra_eths += f"    {nname}:\n      dhcp4: false\n      dhcp6: false\n      addresses:\n        - {cidr}\n      optional: true\n"
            else:
                extra_eths += f"    {nname}:\n      dhcp4: true\n      optional: true\n"

        np_cfg = f"""network:
  version: 2
  ethernets:
{eth0_cfg}{extra_eths}"""
        try:
            np_file = os.path.join(np_dir, "10-lxc.yaml")
            with open(np_file, "w", encoding="utf-8") as f:
                f.write(np_cfg)
            os.chmod(np_file, 0o600)
        except Exception:
            pass

    # 2. Permanently enable systemd-networkd and systemd-resolved in multi-user.target.wants
    wants_dir = os.path.join(rootfs_dir, "etc", "systemd", "system", "multi-user.target.wants")
    try:
        os.makedirs(wants_dir, exist_ok=True)
        for svc in ["systemd-networkd.service", "systemd-resolved.service"]:
            target_link = os.path.join(wants_dir, svc)
            if not os.path.exists(target_link):
                for src_base in ["/lib/systemd/system", "/usr/lib/systemd/system"]:
                    src_full = os.path.join(rootfs_dir, src_base[1:], svc)
                    if os.path.exists(src_full):
                        try:
                            os.symlink(os.path.join(src_base, svc), target_link)
                        except Exception:
                            pass
                        break
        sock_dir = os.path.join(rootfs_dir, "etc", "systemd", "system", "sockets.target.wants")
        os.makedirs(sock_dir, exist_ok=True)
        target_sock = os.path.join(sock_dir, "systemd-networkd.socket")
        if not os.path.exists(target_sock):
            for src_base in ["/lib/systemd/system", "/usr/lib/systemd/system"]:
                if os.path.exists(os.path.join(rootfs_dir, src_base[1:], "systemd-networkd.socket")):
                    try:
                        os.symlink(os.path.join(src_base, "systemd-networkd.socket"), target_sock)
                    except Exception:
                        pass
                    break
    except Exception:
        pass

    # 3. Traditional Debian / Alpine interfaces fallback
    net_dir = os.path.join(rootfs_dir, "etc", "network")
    if os.path.isdir(net_dir):
        ifaces = os.path.join(net_dir, "interfaces")
        try:
            if is_static:
                cidr = ip_str if "/" in ip_str else f"{ip_str}/24"
                ip_addr = cidr.split("/")[0]
                content = f"auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet static\n  address {ip_addr}\n  netmask 255.255.255.0\n  gateway {gw_str}\n  dns-nameservers {gw_str} 223.5.5.5\n"
            else:
                content = "auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet dhcp\n"
            with open(ifaces, "w", encoding="utf-8") as f:
                f.write(content)
        except Exception:
            pass

    # 4. If container is running, live apply
    if is_running and name:
        try:
            run_cmd(["lxc-attach", "-n", name, "--", "systemctl", "enable", "systemd-networkd", "systemd-resolved"])
            run_cmd(["lxc-attach", "-n", name, "--", "netplan", "apply"])
            sync_macvlan_routes()
        except Exception:
            pass

def create_container(params):
    vmid = str(params.get("vmid") or "100").strip()
    name = str(params.get("name") or f"ct-{vmid}").strip()
    template_path = params.get("templatePath")
    storage_target = params.get("storageTarget") or "/mnt/raid10/lxc-containers"
    memory_mib = int(params.get("memoryMiB") or 512)
    cores = int(params.get("cores") or 1)
    bridge = params.get("bridge") or "enp8s0f1"
    password = params.get("password") or "root123"

    lxc_entry = os.path.join(LXC_DIR, name)
    if os.path.exists(lxc_entry) or os.path.islink(lxc_entry):
        return {"success": False, "error": f"容器 {name} 已经存在"}

    # Determine real storage container directory
    if storage_target and os.path.isdir(os.path.dirname(storage_target)):
        os.makedirs(storage_target, exist_ok=True)
        ct_dir = os.path.join(storage_target, name)
    else:
        ct_dir = os.path.join(LXC_DIR, name)

    rootfs_dir = os.path.join(ct_dir, "rootfs")
    os.makedirs(rootfs_dir, exist_ok=True)

    # 1. Extract template if provided
    if template_path and os.path.exists(template_path):
        tar_cmd = ["tar"]
        if template_path.endswith(".zst"):
            tar_cmd.extend(["--zstd", "-xf", template_path, "-C", rootfs_dir])
        elif template_path.endswith(".xz") or template_path.endswith(".gz"):
            tar_cmd.extend(["-xf", template_path, "-C", rootfs_dir])
        else:
            tar_cmd.extend(["-xf", template_path, "-C", rootfs_dir])
        
        rc, out, err = run_cmd(tar_cmd, timeout=300)
        if rc != 0:
            shutil.rmtree(ct_dir, ignore_errors=True)
            return {"success": False, "error": f"解压镜像模板失败: {err or out}"}
    else:
        # Fallback to local busybox / minimal rootfs
        return {"success": False, "error": "请先在【CT 模板管理】中下载或选择一个镜像模板"}

    # 2. Write standard LXC config
    vmid_file = os.path.join(ct_dir, "vmid")
    try:
        with open(vmid_file, "w") as vf:
            vf.write(str(vmid).strip())
    except Exception:
        pass

    # Process Multi-NIC Configuration
    networks = params.get("networks")
    if not networks:
        bridge = params.get("bridge") or "enp8s0f1"
        mac = params.get("mac")
        if bridge.startswith("phys:") or bridge in ('enp12s0f0', 'enp5s0f0', 'enp5s0f1', 'enp7s0f0', 'enp7s0f1'):
            dev = bridge[5:] if bridge.startswith("phys:") else bridge
            networks = [{"type": "phys", "link": dev, "name": "eth0"}]
        elif bridge in ("enp8s0f1", "macvlan", "lan"):
            networks = [{"type": "macvlan", "link": "enp8s0f1", "name": "eth0", "hwaddr": mac, "mode": "bridge"}]
        else:
            networks = [{"type": "veth", "link": bridge, "name": "eth0", "hwaddr": mac}]

    net_cfg_lines = []
    for idx, net in enumerate(networks):
        ntype = net.get("type") or "macvlan"
        nlink = net.get("link") or "enp8s0f1"
        req_mode = net.get("mode")
        if nlink.startswith("phys:"):
            nlink = nlink[5:]
            req_mode = "passthru"

        is_passthru = (req_mode in ("passthru", "passthrough") or ntype in ("phys", "passthru", "passthrough") or (nlink.startswith("enp") and nlink != "enp8s0f1"))
        nname = net.get("name") or f"eth{idx}"
        nhwaddr = net.get("hwaddr") or ("52:54:00:" + ":".join([f"{abs(hash(name + str(idx) + str(i))) % 256:02x}" for i in range(3)]))

        net_cfg_lines.append(f"# Network Adapter {idx} ({nname})")
        if is_passthru:
            net_cfg_lines.append(f"lxc.net.{idx}.type = macvlan")
            net_cfg_lines.append(f"lxc.net.{idx}.macvlan.mode = passthru")
            net_cfg_lines.append(f"lxc.net.{idx}.link = {nlink}")
            net_cfg_lines.append(f"lxc.net.{idx}.name = {nname}")
            net_cfg_lines.append(f"lxc.net.{idx}.flags = up")
        elif ntype == "veth" or nlink.startswith("br") or nlink.startswith("virbr") or nlink == "lxcbr0":
            net_cfg_lines.append(f"lxc.net.{idx}.type = veth")
            net_cfg_lines.append(f"lxc.net.{idx}.link = {nlink}")
            net_cfg_lines.append(f"lxc.net.{idx}.name = {nname}")
            net_cfg_lines.append(f"lxc.net.{idx}.flags = up")
            net_cfg_lines.append(f"lxc.net.{idx}.hwaddr = {nhwaddr}")
        else:
            # Standard macvlan bridge (e.g. enp8s0f1 host management port)
            net_cfg_lines.append(f"lxc.net.{idx}.type = macvlan")
            net_cfg_lines.append(f"lxc.net.{idx}.macvlan.mode = bridge")
            net_cfg_lines.append(f"lxc.net.{idx}.link = {nlink}")
            net_cfg_lines.append(f"lxc.net.{idx}.name = {nname}")
            net_cfg_lines.append(f"lxc.net.{idx}.flags = up")
            net_cfg_lines.append(f"lxc.net.{idx}.hwaddr = {nhwaddr}")
        net_cfg_lines.append("")

    cfg_file = os.path.join(ct_dir, "config")
    cfg_lines = [
        "# Proxmox-compatible LXC Container Configuration",
        f"lxc.uts.name = {name}",
        "lxc.arch = x86_64",
        f"lxc.rootfs.path = dir:{rootfs_dir}",
        "",
        "# Resource Constraints (cgroup v2)",
        f"lxc.cgroup2.memory.max = {memory_mib * 1024 * 1024}",
        f"lxc.cgroup2.cpuset.cpus = 0-{cores - 1}" if cores > 1 else "lxc.cgroup2.cpuset.cpus = 0",
        "lxc.start.auto = 1",
        "lxc.start.delay = 3",
        "",
        *net_cfg_lines,
        "# Proxmox-compatible Nesting and AppArmor (Compatible with Ubuntu 24.04/Systemd 255)",
        "lxc.apparmor.profile = unconfined",
        "lxc.apparmor.allow_nesting = 1",
        "",
        "# Standard LXC Common Configuration",
        "lxc.include = /usr/share/lxc/config/common.conf"
    ]

    # Include OS specific config if exists
    fname_lower = os.path.basename(template_path).lower()
    if "alpine" in fname_lower and os.path.exists("/usr/share/lxc/config/alpine.common.conf"):
        cfg_lines.append("lxc.include = /usr/share/lxc/config/alpine.common.conf")
    elif "debian" in fname_lower and os.path.exists("/usr/share/lxc/config/debian.common.conf"):
        cfg_lines.append("lxc.include = /usr/share/lxc/config/debian.common.conf")
    elif "ubuntu" in fname_lower and os.path.exists("/usr/share/lxc/config/ubuntu.common.conf"):
        cfg_lines.append("lxc.include = /usr/share/lxc/config/ubuntu.common.conf")

    try:
        with open(cfg_file, "w") as f:
            f.write("\n".join(cfg_lines) + "\n")
    except Exception as e:
        shutil.rmtree(ct_dir, ignore_errors=True)
        return {"success": False, "error": f"写入容器配置失败: {e}"}

    # 3. Create symlink in /var/lib/lxc if placed on custom storage
    if ct_dir != lxc_entry:
        if os.path.islink(lxc_entry) or os.path.exists(lxc_entry):
            try: os.remove(lxc_entry)
            except: pass
        try:
            os.symlink(ct_dir, lxc_entry)
        except Exception as e:
            pass

    # 4. Set root password and configure SSH root login
    if os.path.exists(rootfs_dir):
        run_cmd(["chroot", rootfs_dir, "/bin/sh", "-c", f"echo 'root:{password}' | chpasswd"])
        sshd_d = os.path.join(rootfs_dir, "etc", "ssh", "sshd_config.d")
        try:
            os.makedirs(sshd_d, exist_ok=True)
            with open(os.path.join(sshd_d, "01-permitrootlogin.conf"), "w") as sf:
                sf.write("PermitRootLogin yes\nPasswordAuthentication yes\n")
        except Exception:
            pass

    # 5. Ensure networking config inside container (Static or DHCP)
    static_ip = str(params.get("ip") or "").strip()
    gateway = str(params.get("gateway") or "192.168.1.1").strip()
    configure_container_network(rootfs_dir, static_ip, gateway, networks, is_running=False, name=name)

    return {"success": True, "message": f"CT 容器 {name} (VMID: {vmid}) 创建成功，存放于 {storage_target}！"}

def exec_container(params):
    name = str(params.get("name", "")).strip()
    command = str(params.get("command", "")).strip()
    if not name:
        return {"success": False, "error": "缺少容器名称"}
    if not command:
        command = "uname -a; uptime"

    # Verify container exists
    lxc_entry = os.path.join(LXC_DIR, name)
    if not (os.path.exists(lxc_entry) or os.path.islink(lxc_entry)):
        return {"success": False, "error": f"容器 {name} 不存在"}

    rc_st, out_st, _ = run_cmd(["lxc-info", "-n", name, "-s"])
    if "RUNNING" not in out_st:
        return {
            "success": False,
            "error": f"容器 {name} 当前处于停止状态，请先启动容器后再运行命令",
            "stopped": True
        }

    cmd = ["lxc-attach", "-n", name, "--", "sh", "-c", command]
    rc, stdout, stderr = run_cmd(cmd, timeout=30)
    return {
        "success": rc == 0,
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": rc
    }


def edit_container_settings(params):
    name = str(params.get("name", "")).strip()
    if not name:
        return {"success": False, "error": "缺少容器名称"}

    cfg_file = os.path.join(LXC_DIR, name, "config")
    if not os.path.exists(cfg_file):
        return {"success": False, "error": f"容器配置文件不存在: {cfg_file}"}

    real_cfg_file = os.path.realpath(cfg_file)
    conf = parse_container_config(real_cfg_file)
    rootfs_path = conf.get("rootfs") or os.path.join(LXC_DIR, name, "rootfs")
    if rootfs_path.startswith("dir:"):
        rootfs_path = rootfs_path[4:]

    try:
        with open(real_cfg_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        return {"success": False, "error": f"读取容器配置失败: {e}"}

    new_memory_mib = params.get("memoryMiB")
    new_cores = params.get("cores")
    new_autostart = params.get("autostart")
    new_hostname = params.get("hostname")

    # Filter out existing network configuration and headers
    non_net_lines = []
    seen_keys = set()
    for line in lines:
        stripped = line.strip()
        if not stripped:
            non_net_lines.append(line)
            continue
        if stripped.startswith("# Network Adapter") or stripped.startswith("# Networking") or stripped.startswith("# Passthrough physical"):
            continue
        if "=" in stripped:
            k, v = [x.strip() for x in stripped.split("=", 1)]
            if k.startswith("lxc.net."):
                continue
            if k == "lxc.uts.name" and new_hostname:
                non_net_lines.append(f"lxc.uts.name = {new_hostname}\n")
                seen_keys.add("lxc.uts.name")
            elif k in ("lxc.cgroup2.memory.max", "lxc.cgroup.memory.limit_in_bytes") and new_memory_mib is not None:
                mem_bytes = int(new_memory_mib) * 1024 * 1024
                non_net_lines.append(f"lxc.cgroup2.memory.max = {mem_bytes}\n")
                seen_keys.add("lxc.cgroup2.memory.max")
            elif k in ("lxc.cgroup2.cpuset.cpus", "lxc.cgroup.cpuset.cpus") and new_cores is not None:
                c_val = str(new_cores).strip()
                c_str = f"0-{int(c_val)-1}" if c_val.isdigit() and int(c_val) > 1 else c_val
                non_net_lines.append(f"lxc.cgroup2.cpuset.cpus = {c_str}\n")
                seen_keys.add("lxc.cgroup2.cpuset.cpus")
            elif k == "lxc.start.auto" and new_autostart is not None:
                val = "1" if (new_autostart is True or str(new_autostart) in ("1", "true")) else "0"
                non_net_lines.append(f"lxc.start.auto = {val}\n")
                seen_keys.add("lxc.start.auto")
            else:
                non_net_lines.append(line)
        else:
            non_net_lines.append(line)

    if new_autostart is not None and "lxc.start.auto" not in seen_keys:
        val = "1" if (new_autostart is True or str(new_autostart) in ("1", "true")) else "0"
        non_net_lines.append(f"lxc.start.auto = {val}\n")
    if new_memory_mib is not None and "lxc.cgroup2.memory.max" not in seen_keys:
        mem_bytes = int(new_memory_mib) * 1024 * 1024
        non_net_lines.append(f"lxc.cgroup2.memory.max = {mem_bytes}\n")
    if new_cores is not None and "lxc.cgroup2.cpuset.cpus" not in seen_keys:
        c_val = str(new_cores).strip()
        c_str = f"0-{int(c_val)-1}" if c_val.isdigit() and int(c_val) > 1 else c_val
        non_net_lines.append(f"lxc.cgroup2.cpuset.cpus = {c_str}\n")

    # Parse requested networks or fallback to single bridge
    networks = params.get("networks")
    if not networks:
        new_bridge = params.get("bridge") or "enp8s0f1"
        new_mac = params.get("mac")
        if new_bridge.startswith("phys:") or new_bridge in ('enp12s0f0', 'enp5s0f0', 'enp5s0f1', 'enp7s0f0', 'enp7s0f1'):
            dev = new_bridge[5:] if new_bridge.startswith("phys:") else new_bridge
            networks = [{"type": "phys", "link": dev, "name": "eth0"}]
        elif new_bridge in ("enp8s0f1", "macvlan", "lan"):
            networks = [{"type": "macvlan", "link": "enp8s0f1", "name": "eth0", "hwaddr": new_mac, "mode": "bridge"}]
        else:
            networks = [{"type": "veth", "link": new_bridge, "name": "eth0", "hwaddr": new_mac}]

    net_lines = ["\n# Networking (Configured via Network Adapters)\n"]
    for idx, net in enumerate(networks):
        ntype = net.get("type") or "macvlan"
        nlink = net.get("link") or "enp8s0f1"
        req_mode = net.get("mode")
        if nlink.startswith("phys:"):
            nlink = nlink[5:]
            req_mode = "passthru"

        is_passthru = (req_mode in ("passthru", "passthrough") or ntype in ("phys", "passthru", "passthrough") or (nlink.startswith("enp") and nlink != "enp8s0f1"))
        nname = net.get("name") or f"eth{idx}"
        nhwaddr = net.get("hwaddr") or ("52:54:00:" + ":".join([f"{abs(hash(name + str(idx) + str(i))) % 256:02x}" for i in range(3)]))

        net_lines.append(f"# Network Adapter {idx} ({nname})\n")
        if is_passthru:
            net_lines.append(f"lxc.net.{idx}.type = macvlan\n")
            net_lines.append(f"lxc.net.{idx}.macvlan.mode = passthru\n")
            net_lines.append(f"lxc.net.{idx}.link = {nlink}\n")
            net_lines.append(f"lxc.net.{idx}.name = {nname}\n")
            net_lines.append(f"lxc.net.{idx}.flags = up\n")
        elif ntype == "veth" or nlink.startswith("br") or nlink.startswith("virbr") or nlink == "lxcbr0":
            net_lines.append(f"lxc.net.{idx}.type = veth\n")
            net_lines.append(f"lxc.net.{idx}.link = {nlink}\n")
            net_lines.append(f"lxc.net.{idx}.name = {nname}\n")
            net_lines.append(f"lxc.net.{idx}.flags = up\n")
            net_lines.append(f"lxc.net.{idx}.hwaddr = {nhwaddr}\n")
        else:
            # Standard macvlan bridge (e.g. enp8s0f1 host management port)
            net_lines.append(f"lxc.net.{idx}.type = macvlan\n")
            net_lines.append(f"lxc.net.{idx}.macvlan.mode = bridge\n")
            net_lines.append(f"lxc.net.{idx}.link = {nlink}\n")
            net_lines.append(f"lxc.net.{idx}.name = {nname}\n")
            net_lines.append(f"lxc.net.{idx}.flags = up\n")
            net_lines.append(f"lxc.net.{idx}.hwaddr = {nhwaddr}\n")
        net_lines.append("\n")

    # Combine non_net_lines with net_lines
    final_lines = []
    inserted = False
    for line in non_net_lines:
        if ("lxc.include" in line or "common.conf" in line) and not inserted:
            final_lines.extend(net_lines)
            inserted = True
        final_lines.append(line)
    if not inserted:
        final_lines.extend(net_lines)

    try:
        with open(real_cfg_file, "w", encoding="utf-8") as f:
            f.writelines(final_lines)
    except Exception as e:
        return {"success": False, "error": f"保存配置失败: {e}"}

    # If running, hot-apply cgroups
    rc_st, out_st, _ = run_cmd(["lxc-info", "-n", name, "-s"])
    is_running = ("RUNNING" in out_st)
    hot_applied = False
    if is_running:
        if new_memory_mib:
            run_cmd(["lxc-cgroup", "-n", name, "memory.max", str(int(new_memory_mib) * 1024 * 1024)])
        if new_cores is not None:
            c_val = str(new_cores).strip()
            c_str = f"0-{int(c_val)-1}" if c_val.isdigit() and int(c_val) > 1 else c_val
            run_cmd(["lxc-cgroup", "-n", name, "cpuset.cpus", c_str])
        hot_applied = True

    # 1. Password Reset & SSH PermitRootLogin
    new_password = params.get("password")
    if new_password and str(new_password).strip():
        pwd = str(new_password).strip()
        if is_running:
            run_cmd(["lxc-attach", "-n", name, "--", "/bin/sh", "-c", f"echo 'root:{pwd}' | chpasswd"])
        elif os.path.exists(rootfs_path):
            run_cmd(["chroot", rootfs_path, "/bin/sh", "-c", f"echo 'root:{pwd}' | chpasswd"])
        sshd_d = os.path.join(rootfs_path, "etc", "ssh", "sshd_config.d")
        try:
            os.makedirs(sshd_d, exist_ok=True)
            with open(os.path.join(sshd_d, "01-permitrootlogin.conf"), "w") as sf:
                sf.write("PermitRootLogin yes\nPasswordAuthentication yes\n")
            if is_running:
                run_cmd(["lxc-attach", "-n", name, "--", "systemctl", "restart", "ssh"])
                run_cmd(["lxc-attach", "-n", name, "--", "systemctl", "restart", "ssh.socket"])
        except Exception:
            pass

    # 2. Static IP / Netplan / DHCP update
    new_ip = params.get("ip")
    new_gateway = params.get("gateway") or "192.168.1.1"
    configure_container_network(rootfs_path, new_ip, new_gateway, networks, is_running=is_running, name=name)

    msg = f"CT 容器 {name} 配置已更新！"
    if is_running:
        # Restart container to release removed physical NICs or attach new ones
        run_cmd(["lxc-stop", "-n", name, "-t", "3"])
        run_cmd(["lxc-start", "-n", name, "-d"])
        msg += " 已自动重启容器，新网卡配置已立即生效！"
    else:
        msg += " 配置已写入磁盘，将在下次启动时生效。"

    return {"success": True, "message": msg, "hotApplied": hot_applied}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified"}))
        sys.exit(1)

    action = sys.argv[1]

    if action in ("host-interfaces", "host_interfaces"):
        print(json.dumps(get_host_network_interfaces()))

    elif action == "status":
        print(json.dumps(check_lxc_installed()))

    elif action == "sources":
        print(json.dumps(get_template_sources()))

    elif action == "local_templates":
        print(json.dumps(get_local_templates()))

    elif action == "download_status":
        print(json.dumps(get_download_status()))

    elif action == "download":
        try:
            params = json.loads(sys.stdin.read())
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON payload: {e}"}))
            sys.exit(1)
        print(json.dumps(start_download_template(params)))

    elif action == "delete_template":
        try:
            params = json.loads(sys.stdin.read())
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON payload: {e}"}))
            sys.exit(1)
        print(json.dumps(delete_template(params.get("path"))))

    elif action == "list":
        print(json.dumps(list_containers()))

    elif action == "action":
        if len(sys.argv) < 4:
            print(json.dumps({"success": False, "error": "Usage: action <name> <start|stop|kill|restart|destroy>"}))
            sys.exit(1)
        name = sys.argv[2]
        act = sys.argv[3]
        print(json.dumps(action_container(name, act)))

    elif action == "create":
        try:
            params = json.loads(sys.stdin.read())
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON payload: {e}"}))
            sys.exit(1)
        print(json.dumps(create_container(params)))

    elif action == "exec":
        try:
            params = json.loads(sys.stdin.read())
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON payload: {e}"}))
            sys.exit(1)
        print(json.dumps(exec_container(params)))

    elif action in ("edit-settings", "edit_settings"):
        try:
            params = json.loads(sys.stdin.read())
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON payload: {e}"}))
            sys.exit(1)
        print(json.dumps(edit_container_settings(params)))

    else:
        print(json.dumps({"error": f"Unknown action: {action}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
