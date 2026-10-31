import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { analyze, overlay } from '../js/analysis.js';

const U = '/mnt/user-data/uploads/';
const A = '/mnt/user-data/attachments/4e5bdbe6-4b76-52f9-bdec-9e90a80fba07/ec9499a5-image.jpg';
const cases = [
  ['img1', U + '20261029_062512982_iOS.jpg', [[72, 65], [405, 75], [430, 965], [95, 970]], 86.9],
  ['img2', U + '20261029_062518041_iOS.jpg', [[150, 70], [535, 60], [525, 780], [85, 770]], 86.6],
  ['img3', U + '20261029_062531825_iOS.jpg', [[92, 45], [277, 38], [278, 605], [100, 610]], 87.4],
  ['fail', A, [[74, 62], [402, 62], [430, 965], [95, 970]], 62.9],
];
const out = process.argv[2] || '/tmp';
let bad = 0;
for (const [name, path, corners, expect] of cases) {
  const img = jpeg.decode(fs.readFileSync(path), { useTArray: true });
  const t0 = Date.now();
  const r = analyze(img, corners);
  const ms = Date.now() - t0;
  const diff = Math.abs(r.fillPct - expect);
  if (diff > 1.0) bad++;
  console.log(name, 'fill=' + r.fillPct.toFixed(1), 'expect≈' + expect, 'diff=' + diff.toFixed(2), r.result, 'thr=' + r.threshold, ms + 'ms');
  const ov = overlay(r), png = new PNG({ width: ov.width, height: ov.height });
  png.data = Buffer.from(ov.data.buffer);
  fs.writeFileSync(`${out}/js_${name}.png`, PNG.sync.write(png));
}
console.log(bad ? 'MISMATCH' : 'ALL OK (±1pt of Python reference)');
process.exit(bad ? 1 : 0);
