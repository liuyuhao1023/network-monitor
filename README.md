# 🚀 Network Monitor Dashboard (边缘服务器与网络集群综合管理面板)

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v18+-68a063?style=flat-square&logo=node.js" alt="Node.js Version" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Linux%20%7C%20Ubuntu%20%7C%20Debian-orange?style=flat-square&logo=linux" alt="Platform" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome" />
</p>

一款专为 Linux 边缘服务器、软路由、轻量 NAS 及分布式节点打造的**高颜值、一体化、轻量级全栈监控与管理面板**。无需复杂重型依赖，单节点毫秒级响应，支持多节点集群、RAID 阵列运维、UPS 电源自适应能耗、智能分流网关及全模块独立 Webhook 告警推送。

---

## ✨ 核心功能亮点 (Key Features)

### 1. 🌐 实时网络与流量分析 (Network & Traffic Analytics)
- **实时带宽仪表盘**：动态双向波形折线图，精确展示各物理网卡（以太网、WiFi、4G/5G 模组）的瞬时速率与累计吞吐量。
- **下挂设备与 DHCP 管理**：自动发现内网在线客户端，支持自定义备注命名与速率追踪。
- **4G 灾备 Watchdog 守护**：以太网故障时毫秒级自动切换 4G 模组灾备路由并发送通知。

### 2. 💾 存储与软 RAID 运维管理 (Storage & RAID Management)
- **Linux mdadm 阵列监控**：支持 RAID0、RAID1、RAID5 等阵列全生命周期监控，精准识别正常 (Healthy)、降级 (Degraded)、损毁 (Failed) 及后台同步进度。
- **掉盘与热插拔自愈**：磁盘拔出或掉线时实时标红报警；磁盘重新插入后智能识别候选盘并提供 **「一键重新加入并同步 (`mdadm --add`)」**。
- **磁盘健康度与 SMART 诊断**：全面读取通电时间、物理坏道数量、介质类型（SSD/HDD）与健康度百分比。
- **网络共享集成**：一键管理 Samba、NFS、FTP 存储挂载点与共享权限。

### 3. ⚡ UPS 电源能耗与电能质量 (UPS Power & Energy Analytics)
- **全协议无缝兼容**：支持硕天 (CyberPower) USB-HID 直连、山特 (SANTAK) 在线双变换 TCP 串口服务器、APC 及 Network UPS Tools (NUT)。
- **自适应能耗拓扑引擎**：智能区分 GreenPower 节能互动式（自耗 ≈ 4.5W）与 在线双变换式（自耗 ≈ 48W），精准计算自身损耗与后端有效负载。
- **用电报表与节能核算**：提供 30 天每日用电统计、电费估算及节能对比报表。
- **电能质量预警**：电压过高/过低、频率偏移、旁路模式及电池更换健康告警。

### 4. 🏢 分布式多节点集群中枢 (Multi-Node Cluster)
- **极简一键纳管**：生成专属脚本（`curl -fsSL ... | bash`），10 秒内将边缘从节点纳管至集群。
- **全局集群监控屏**：多维度概览所有从节点的 CPU、内存、磁盘、网速、运行时间与硬件温度。

### 5. 🔔 多模块统一推送管理中枢 (Unified Notification Hub)
- **业务模块独立通道**：6 大核心业务板块（存储RAID、UPS电源、网络集群、流量超限、安全防护、系统硬件）**均支持独立配置 Webhook / Token 地址**。
- **全局兜底 + 细粒度过滤**：模块未填时自动继承全局默认通道，支持企业微信、钉钉机器人（支持加签）、飞书、Bark、Server酱等。
- **高仿真模块测试**：各模块配备独立 `[测试]` 按钮，一键发送真实 Markdown 告警卡片并提供全链路审计日志。

### 6. 🚀 OpenClash / Mihomo 智能分流与网关
- 节点切换、策略组测速、订阅配置管理及运行模式（Redir-Host / Fake-IP / 混合模式）无缝切换。

### 7. 🌐 Nginx 网站托管与服务发布
- 支持静态 HTML、Node.js API、WordPress 等站点快速创建、反向代理配置与 SSL 证书管理。

---

## 🛠️ 快速开始 (Quick Start)

### 方式一：直接运行 (Direct Run)

```bash
# 1. 克隆代码仓库
git clone https://github.com/<your-username>/network-monitor.git
cd network-monitor

# 2. 安装轻量依赖 (仅需 express)
npm install

# 3. 启动服务 (默认端口 10002)
npm start
```

访问控制台：`http://<your-server-ip>:10002`

---

### 方式二：配置为 Systemd 系统服务 (推荐生产环境)

创建服务文件 `/etc/systemd/system/network-monitor.service`：

```ini
[Unit]
Description=Network Monitor Dashboard Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/network-monitor
ExecStart=/usr/bin/node /opt/network-monitor/server.js
Restart=always
RestartSec=5
Environment=PORT=10002
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now network-monitor.service
sudo systemctl status network-monitor.service
```

---

## 📁 目录结构 (Directory Structure)

```text
├── public/                 # 前端单页面应用 (SPA)
│   ├── index.html          # 主界面结构 (多Tab现代化布局)
│   ├── style.css           # 现代化高保真深色/浅色主题样式
│   └── app.js              # 前端交互逻辑、API轮询与可视化图表
├── server.js               # Node.js Express 后端核心服务 (系统监控与RESTful API)
├── package.json            # 项目依赖与元数据配置
├── LICENSE                 # MIT 开源许可证
└── README.md               # 项目使用与开发说明文档
```

---

## 🔒 安全建议 (Security Best Practices)

1. **默认登录保护**：首次使用建议在设置中修改管理员初始凭据。
2. **防火墙配置**：仅允许受信任的内网 IP 或通过反向代理（如 Nginx + SSL）暴露服务端口。
3. **Webhook 地址保护**：敏感机器人 Token 请勿直接硬编码提交至公共代码仓库。

---

## 🤝 参与贡献 (Contributing)

欢迎提交 Issue 和 Pull Request！
1. Fork 本项目
2. 创建您的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交您的修改 (`git commit -m 'feat: Add some AmazingFeature'`)
4. 推送至分支 (`git push origin feature/AmazingFeature`)
5. 新建 Pull Request

---

## 📄 开源许可证 (License)

本项目采用 [MIT License](LICENSE) 开源许可证。
