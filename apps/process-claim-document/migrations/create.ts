import fs from 'fs';
import path from 'path';

const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run migrate:create <migration_name>');
  process.exit(1);
}

function timestamp(): string {
  const d   = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function template(id: string): string {
  return `import type { Pool } from 'pg';
import type { Migration } from './base';

const migration: Migration = {
  id: '${id}',

  async up(pool: Pool): Promise<void> {
    await pool.query(\`
      -- write your UP SQL here
    \`);
  },

  async down(pool: Pool): Promise<void> {
    await pool.query(\`
      -- write your DOWN SQL here
    \`);
  },
};

export default migration;
`;
}

const id       = `${timestamp()}_${name}`;
const filePath = path.join(__dirname, `${id}.ts`);
fs.writeFileSync(filePath, template(id), 'utf8');
console.log(`Created: ${filePath}`);
