// analyze-probe.js — after a few days of hourly probes, shows which hours new open-box SKUs tend to appear.
//   node scripts/analyze-probe.js
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'data', 'probe.jsonl');
if (!fs.existsSync(file)) { console.log('no data/probe.jsonl yet'); process.exit(0); }
const runs = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byHour = Array(24).fill(0), removedByHour = Array(24).fill(0), probesByHour = Array(24).fill(0);
for (const r of runs.slice(1)) {
  const h = new Date(r.ts).getHours(); // local time
  byHour[h] += r.added; removedByHour[h] += r.removed; probesByHour[h]++;
}
console.log(`${runs.length} probes from ${runs[0].ts} to ${runs[runs.length - 1].ts}\n`);
console.log('hour  probes  +added  -removed');
for (let h = 0; h < 24; h++) console.log(String(h).padStart(4), String(probesByHour[h]).padStart(7), String(byHour[h]).padStart(7), String(removedByHour[h]).padStart(9), ' ' + '#'.repeat(Math.min(60, byHour[h])));
const total = byHour.reduce((a, b) => a + b, 0);
console.log(`\ntotal new SKUs observed: ${total}; avg per probe: ${(total / Math.max(1, runs.length - 1)).toFixed(1)}`);
