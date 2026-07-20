export class RecentLogBuffer<T> {
  private records: T[] = []
  private start = 0

  constructor(private limit: number) {}

  push(record: T) {
    if (this.records.length < this.limit) {
      this.records.push(record)
      return
    }
    this.records[this.start] = record
    this.start = (this.start + 1) % this.limit
  }

  values() {
    if (!this.start) return this.records.slice()
    return [...this.records.slice(this.start), ...this.records.slice(0, this.start)]
  }
}
