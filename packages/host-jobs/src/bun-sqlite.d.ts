declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string);
    exec(sql: string): void;
    query(sql: string): {
      get(...parameters: unknown[]): unknown;
      all(...parameters: unknown[]): unknown[];
      run(...parameters: unknown[]): unknown;
    };
    prepare(sql: string): {
      get(...parameters: unknown[]): unknown;
      all(...parameters: unknown[]): unknown[];
      run(...parameters: unknown[]): unknown;
    };
    close(): void;
  }
}
