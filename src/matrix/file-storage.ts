import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export class FileStorage implements Storage {
  private data: Record<string, string> = {};

  constructor(private readonly filePath: string) {
    this.load();
  }

  get length(): number {
    return Object.keys(this.data).length;
  }

  key(index: number): string | null {
    return Object.keys(this.data)[index] ?? null;
  }

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, key)
      ? this.data[key]
      : null;
  }

  setItem(key: string, value: string): void {
    this.data[key] = String(value);
    this.flush();
  }

  removeItem(key: string): void {
    delete this.data[key];
    this.flush();
  }

  clear(): void {
    this.data = {};
    this.flush();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8");
    this.data = JSON.parse(raw) as Record<string, string>;
  }

  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
