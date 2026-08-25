import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const outDir = 'public';
const files = ['index.html', 'app.js', 'styles.css', 'wake.css'];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const file of files) {
  await copyFile(file, join(outDir, file));
}

console.log(`LabSight static frontend built to ${outDir}/`);
