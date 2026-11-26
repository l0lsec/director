import { LibraryDb } from './db';
import { Brands } from './brands';
import { Swipe } from './swipe';
import { Studio } from './scripts';
import { Usage } from './usage';

export * from './db';
export * from './brands';
export * from './swipe';
export * from './scripts';
export * from './usage';

/** One handle to the whole local library (a single SQLite file). */
export class Library {
  readonly db: LibraryDb;
  readonly brands: Brands;
  readonly swipe: Swipe;
  readonly studio: Studio;
  readonly usage: Usage;
  constructor(path: string, now?: () => string) {
    this.db = new LibraryDb(path, now);
    this.brands = new Brands(this.db);
    this.swipe = new Swipe(this.db);
    this.studio = new Studio(this.db);
    this.usage = new Usage(this.db);
  }
  close(): void { this.db.close(); }
}
