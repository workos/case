import { writeFileSync } from 'node:fs';

writeFileSync('path/to/.task.json', JSON.stringify({ status: 'implementing' }));
