// Bounded set of recently seen trade ids. On every reconnect Coinbase
// replays recent trades in a snapshot event, so without this the same
// trade would be stored and aggregated twice.
//
// A JS Set iterates in insertion order, which makes it a FIFO for free:
// when over capacity, delete from the front.

export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  // Records the id and reports whether it was already present.
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return false;
  }
}
