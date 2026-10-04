import { config } from './config.js';
import { StoreDb } from './db.js';
import { Scanner } from './scanner.js';

const db = new StoreDb(config.databasePath);
const scanner = new Scanner(db, undefined, config.concurrency);
const mode = process.argv[2] ?? 'scan';
function argumentValue(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  return process.argv[index].includes('=') ? process.argv[index].split('=').slice(1).join('=') : process.argv[index + 1];
}
const value = argumentValue('--limit');
const limit = value === undefined ? config.catalogScanLimit : Math.max(0, Number(value));

const result = mode === 'bootstrap' ? await scanner.bootstrap() : await scanner.run(limit);
console.log(JSON.stringify(result, null, 2));
