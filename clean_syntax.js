const fs = require('fs');
const path = 'C:/Users/Dmitry/.gemini/antigravity/scratch/ag-engineer-source/ag-engineer-main/src/platform/discovery.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(/\\`/g, '`');
code = code.replace(/\\\$\{/g, '${');
code = code.replace(/\/\\\\r\?\\\\n\//g, '/\\r?\\n/');
code = code.replace(/\/^\\\\d\+\$\//g, '/^\\d+$/');

fs.writeFileSync(path, code, 'utf8');
console.log('Fixed syntax escapes!');
