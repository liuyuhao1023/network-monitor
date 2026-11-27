const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const run = require('util').promisify(execFile);
const read = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const unknown = '未提供';
let cached;
module.exports = async function hardware() {
    if (cached && Date.now() - cached.at < 60000) return cached.data;
    let fields = {};
    try {
        const { stdout } = await run('lscpu', ['-J'], { env: { ...process.env, LC_ALL: 'C' }, timeout: 3000 });
        fields = Object.fromEntries(JSON.parse(stdout).lscpu.map(x => [x.field.replace(/:$/, ''), x.data]));
    } catch {}
    const mhz = value => Number(value) > 0 ? (Number(value) / 1000).toFixed(2) + ' GHz' : unknown;
    const model = fields['Model name'] || os.cpus()[0]?.model || unknown;
    const baseKhz = read('/sys/devices/system/cpu/cpu0/cpufreq/base_frequency');
    const cpu = {
        model, vendor: fields['Vendor ID'] || unknown,
        coresCount: Number(fields['Core(s) per socket']) * Number(fields['Socket(s)']) || null,
        logicalCount: Number(fields['CPU(s)']) || os.cpus().length,
        arch: fields.Architecture || os.arch(),
        l1Cache: [fields['L1d cache'], fields['L1i cache']].filter(Boolean).join(' + ') || unknown,
        l2Cache: fields['L2 cache'] || unknown, l3Cache: fields['L3 cache'] || unknown,
        baseFreq: baseKhz ? mhz(Number(baseKhz) / 1000) : (model.match(/@\s*([\d.]+)GHz/i)?.[1] ? model.match(/@\s*([\d.]+)GHz/i)[1] + ' GHz' : unknown),
        maxFreq: mhz(fields['CPU max MHz']), virtualization: fields.Virtualization || unknown
    };
    const gpu = Object.fromEntries(['model','vendor','driver','pciSlot','vramFmt','curFreqFmt','actFreqFmt','maxFreqFmt','memFreqFmt','powerFmt','tempFmt','displayOutputs'].map(k => [k, unknown]));
    gpu.usagePct = null;
    gpu.status = '未检测到显卡';
    try {
        const { stdout } = await run('lspci', ['-Dnn'], { env: { ...process.env, LC_ALL: 'C' }, timeout: 3000 });
        const line = stdout.split('\n').find(l => /(?:VGA compatible controller|3D controller|Display controller)/.test(l));
        if (line) {
            gpu.pciSlot = line.split(' ')[0];
            gpu.model = line.replace(/^[^ ]+ .*?\]:\s*/, '');
            const dir = '/sys/bus/pci/devices/' + gpu.pciSlot;
            try { gpu.driver = require('path').basename(fs.readlinkSync(dir + '/driver')); } catch {}
            gpu.vendor = ({ '0x1a03': 'ASPEED Technology', '0x8086': 'Intel', '0x10de': 'NVIDIA', '0x1002': 'AMD' })[read(dir + '/vendor')] || read(dir + '/vendor') || unknown;
            gpu.status = gpu.driver === unknown ? '已检测到，未识别驱动' : '已加载驱动';
        }
    } catch {}
    const data = { cpu, gpu };
    cached = { at: Date.now(), data };
    return data;
};
