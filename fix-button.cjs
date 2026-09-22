const fs = require('fs');
const file = 'src/pages/admin/PerTripSalesPage.jsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/\{loadingReport \? <CenteredSpinner size=\{16\} \/> : <FileText size=\{16\} \/>\}/, "{loadingReport ? <RefreshCw size={16} className=\"animate-spin\" /> : <FileText size={16} />}");
content = content.replace(/import \{ FileText, CalendarDays, Search, Printer, AlertTriangle, Download, RefreshCw/g, 'import { FileText, CalendarDays, Search, Printer, AlertTriangle, Download, RefreshCw'); // ensuring RefreshCw is imported

fs.writeFileSync(file, content);
