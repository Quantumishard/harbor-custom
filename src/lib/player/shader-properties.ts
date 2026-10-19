/** Apply temporary shader properties serially and restore the user's values. */
export class ShaderProperties {
  private original = new Map<string, unknown>();
  private queue: Promise<void> = Promise.resolve();
  private revision = 0;

  constructor(
    private read: (name: string) => Promise<unknown>,
    private write: (name: string, value: unknown) => Promise<unknown>,
  ) {}

  apply(props: Record<string, string>): Promise<void> {
    const revision = ++this.revision;
    const wanted = { ...props };
    this.queue = this.queue.then(async () => {
      for (const [name, value] of this.original) {
        if (revision !== this.revision) return;
        if (name in wanted) continue;
        await this.write(name, value);
        this.original.delete(name);
      }
      for (const [name, value] of Object.entries(wanted)) {
        if (revision !== this.revision) return;
        if (!this.original.has(name)) this.original.set(name, await this.read(name));
        if (revision !== this.revision) return;
        await this.write(name, value);
      }
    }).catch((error) => console.warn("[shaders] property update failed", error));
    return this.queue;
  }
}
