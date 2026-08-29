import type { Pool } from 'pg';

export interface Migration {
  id: string;
  up(pool: Pool): Promise<void>;
  down(pool: Pool): Promise<void>;
}
