import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;

export const getDb = (d1: D1Database): Db => drizzle(d1, { schema });
