const fs = require('fs');
const file = 'src/pages/admin/PerTripSalesPage.jsx';
let content = fs.readFileSync(file, 'utf8');

// Remove the Print Report button from the top right
content = content.replace(/<button type="button" className="btn btn-primary btn-sm" onClick=\{handlePrint\} disabled=\{!hasGenerated\}>\s*<Printer size=\{16\} \/>\s*Print Report\s*<\/button>\s*/, '');

// Find the Generate Report button and its container closing tags
const generateBtnRegex = /(<button\s*type="button"\s*className="btn btn-primary btn-sm"\s*onClick=\{handleGenerate\}.*?<\/button>)/s;

content = content.replace(generateBtnRegex, `$1
          {hasGenerated && (
            <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint}>
              <Printer size={16} />
              Print Report
            </button>
          )}`);

fs.writeFileSync(file, content);
