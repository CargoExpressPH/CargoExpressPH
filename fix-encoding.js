const fs = require('fs');
const file = 'src/lib/database.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/Ã¢â‚¬â€ /g, '—');
content = content.replace(/Ã¢â€ â€™/g, '→');
content = content.replace(/Ã¢â€ â‚¬/g, '─');

fs.writeFileSync(file, content);
console.log('Fixed encodings in database.js');
