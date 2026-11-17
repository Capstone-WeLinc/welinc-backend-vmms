import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERASURE_COPY_COLUMNS } from './erasure-rewrite';

function columnsOf(schema: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const body = match[2];
    const table = /@@map\("([^\"]+)"\)/.exec(body)?.[1] ?? match[1];
    const columns = new Set<string>();
    for (const line of body.split('\n')) {
      const field = /^\s+(\w+)\s+\w/.exec(line);
      if (!field || line.trim().startsWith('@@')) continue;
      columns.add(/@map\("([^\"]+)"\)/.exec(line)?.[1] ?? field[1]);
    }
    tables.set(table, columns);
  }
  return tables;
}

describe('VMMS erased identity rewrite map', () => {
  const schema = readFileSync(join(__dirname, '../../../../prisma/schema.prisma'), 'utf8');
  const tables = columnsOf(schema);

  it('references only existing copied identity columns', () => {
    for (const copy of ERASURE_COPY_COLUMNS) {
      const columns = tables.get(copy.table);
      expect(columns).toBeDefined();
      expect(columns).toContain(copy.idColumn);
      if ('nameColumn' in copy) expect(columns).toContain(copy.nameColumn);
      if ('emailColumn' in copy) expect(columns).toContain(copy.emailColumn);
    }
  });
});
