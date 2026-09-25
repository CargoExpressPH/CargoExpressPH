import fs from 'fs';
const file = 'src/lib/database.js';
let content = fs.readFileSync(file, 'utf8');

// Replace using literal strings that got written by grep
content = content.replace(/Ã¢â‚¬â€/g, '—');
content = content.replace(/Ã¢â€ â€™/g, '→');
content = content.replace(/Ã¢â€ â‚¬/g, '─');

fs.writeFileSync(file, content);
console.log('Fixed encodings in database.js');
