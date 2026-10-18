// Convert the public "Retail sales dataset of a pharmacy in Indonesia" (Gustriansyah, Mendeley Data,
// DOI 10.17632/2ym7v78wtd.1, CC BY 4.0) into a daily per-product CSV for `npm run backtest:csv`.
//
//   node scripts/prepare-pharmacy-dataset.js data/external/mendeley-pharmacy/sales.sql data/external/pharmacy-daily.csv
//
// The download is a MariaDB dump. We never execute it: the `transaction` table's INSERT rows are
// parsed as text (NO_RESEP, TGL, KD_CUST, KD_OBAT, QTY, HNA, HJ) and summed to (date, product) totals.
// Rows with non-positive quantity (returns/corrections) are skipped and counted.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/prepare-pharmacy-dataset.js <sales.sql> <out.csv>');
  process.exit(1);
}

// One value row of the transaction table, e.g. ('B-04.2015-09-0004', '2015-04-23', 'UMUM', 'R-4027', 10, 2112, 2904),
const ROW = /^\s*\('((?:[^'\\]|\\.)*)', '(\d{4}-\d{2}-\d{2})', '(?:[^'\\]|\\.)*', '((?:[^'\\]|\\.)*)', (-?[\d.]+(?:e[+-]?\d+)?), /i;

const totals = new Map(); // "date,product" -> qty
let inTransaction = false, rows = 0, skipped = 0, malformed = 0;

const rl = createInterface({ input: createReadStream(input, { encoding: 'latin1' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.startsWith('INSERT INTO `')) { inTransaction = line.startsWith('INSERT INTO `transaction`'); continue; }
  if (!inTransaction || !line.trimStart().startsWith("('")) continue;
  const m = ROW.exec(line);
  if (!m) { malformed++; continue; }
  const [, , day, product, qtyText] = m;
  const qty = Number(qtyText);
  if (!(qty > 0)) { skipped++; continue; }
  rows++;
  const key = `${day},${product.trim()}`;
  totals.set(key, (totals.get(key) ?? 0) + qty);
}

const lines = ['date,item,sales'];
for (const [key, qty] of [...totals].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`${key},${Math.round(qty * 1000) / 1000}`);
writeFileSync(output, `${lines.join('\n')}\n`);
const days = new Set([...totals.keys()].map((k) => k.slice(0, 10)));
const products = new Set([...totals.keys()].map((k) => k.slice(11)));
console.log(`transaction rows used: ${rows}, skipped (qty ≤ 0): ${skipped}, unparsed: ${malformed}`);
console.log(`→ ${totals.size} (day, product) totals, ${products.size} products, ${days.size} days (${[...days].sort()[0]} → ${[...days].sort().at(-1)}) → ${output}`);
