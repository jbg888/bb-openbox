// build.js — rebuild docs/index.html from data/deals.json without scraping (useful after editing the template).
const fs = require('fs');
const path = require('path');
const P = (...x) => path.join(__dirname, ...x);
const payload = JSON.parse(fs.readFileSync(P('data', 'deals.json'), 'utf8'));
const tpl = fs.readFileSync(P('site', 'template.html'), 'utf8');
fs.mkdirSync(P('docs'), { recursive: true });
fs.writeFileSync(P('docs', 'index.html'), tpl.replace('/*__DATA__*/null', JSON.stringify(payload).replace(/<\//g, '<\\/')));
fs.writeFileSync(P('docs', 'deals.json'), JSON.stringify(payload));
console.log('built docs/index.html with', payload.items.length, 'items');
