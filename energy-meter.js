'use strict';
const fs=require('fs');
function deltaWatts(previous,current,range,seconds) {
    if (![previous,current,range,seconds].every(Number.isFinite) || seconds<=0 || range<=0) return null;
    const delta=current>=previous ? current-previous : range-previous+current;
    const watts=delta/1e6/seconds;
    return watts>=0 && watts<2000 ? Math.round(watts*100)/100 : null;
}
let last=new Map(), latest={timestamp:null,domains:[],intervalSeconds:2};
function sample() {
    const now=Date.now(), domains=[];
    try {
        for(const entry of fs.readdirSync('/sys/class/powercap').filter(n=>/^intel-rapl:\d+(?::\d+)*$/.test(n))) {
            const dir='/sys/class/powercap/'+entry;
            try {
                const name=fs.readFileSync(dir+'/name','utf8').trim();
                const energy=Number(fs.readFileSync(dir+'/energy_uj','utf8'));
                const range=Number(fs.readFileSync(dir+'/max_energy_range_uj','utf8'));
                const prev=last.get(entry);
                domains.push({id:entry,name,watts:prev?deltaWatts(prev.energy,energy,range,(now-prev.time)/1000):null});
                last.set(entry,{energy,time:now});
            } catch {}
        }
    } catch {}
    latest={timestamp:now,domains,intervalSeconds:2};
}
sample();
setInterval(sample,2000).unref();
module.exports={reading:()=>latest,deltaWatts};
