// Providers own execution. This scheduler never imports/acquires the MTP lane.
export class ThumbnailService {
  constructor({
    provider,
    createUrl = (bytes) =>
      URL.createObjectURL(new Blob([bytes], { type: 'image/png' })),
    revokeUrl = (url) => URL.revokeObjectURL(url),
    maxJobs = 2,
    maxEntries = 64,
    maxBytes = 16 * 1024 * 1024,
    maxPending = 64,
  }) {
    Object.assign(this, {
      provider,
      createUrl,
      revokeUrl,
      maxJobs,
      maxEntries,
      maxBytes,
      maxPending,
    });
    this.dimensions = { width: 160, height: 160 };
    this.cache = new Map();
    this.failures = new Map();
    this.inflight = new Map();
    this.pending = new Map();
    this.running = new Map();
    this.capacityListeners = new Set();
    this.active = 0;
    this.bytes = 0;
  }

  current(client) {
    return client.active && client.isCurrent();
  }

  wanted(job) {
    return [...job.clients].some((client) => this.current(client));
  }

  notify(client, src) {
    if (this.current(client)) client.onResult(src);
  }

  request(item, { revision, context, isCurrent, onResult }) {
    const client = { active: true, isCurrent, onResult, entry: null };
    const failureKey = JSON.stringify([
      item.path,
      item.size,
      item.dateAdded,
      revision,
      context?.key,
    ]);
    // A replacement joins the same admitted job, even when its original
    // consumer has gone away. Revisions and MTP scope remain part of identity.
    const requestKey = failureKey;
    let job = this.running.get(requestKey) || this.pending.get(requestKey);

    if (!job && !this.failures.has(failureKey)) {
      // A bounded waiting set; rejected visible items simply retain icons.
      if (this.pending.size < this.maxPending) {
        job = { item, context, clients: new Set(), failureKeys: new Set() };
        this.pending.set(requestKey, job);
      }
    }

    if (job) {
      job.clients.add(client);
      job.failureKeys.add(failureKey);
      this.drain();
    }

    return {
      deferred: !job && !this.failures.has(failureKey),
      cancel: () => {
        client.active = false;
        client.entry?.clients.delete(client);
        client.entry = null;
        job?.clients.delete(client);
        if (
          job &&
          !job.started &&
          !job.clients.size &&
          this.pending.get(requestKey) === job
        )
          this.pending.delete(requestKey);
      },
      fail: () => {
        if (this.current(client) && client.entry) this.release(client.entry);
      },
    };
  }

  release(entry) {
    if (entry.src) {
      this.revokeUrl(entry.src);
      this.bytes -= entry.bytes;
      Object.assign(entry, { src: null, bytes: 0 });
    }

    entry.clients.forEach((client) => {
      Object.assign(client, { entry: null });
      this.notify(client, null);
    });
    entry.clients.clear();
  }

  subscribeCapacity(listener) {
    // Visibility subscriptions carry no file work or native lease. The actual
    // waiting-job set remains bounded; failures never subscribe for retries.
    this.capacityListeners.add(listener);

    return () => this.capacityListeners.delete(listener);
  }

  notifyCapacity() {
    if (this.pending.size < this.maxPending)
      [...this.capacityListeners].forEach((listener) => listener());
  }

  remember(key, entry) {
    this.cache.set(key, entry);
    this.bytes += entry.bytes;
    while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.cache.keys().next().value;

      this.release(this.cache.get(oldest));
      this.cache.delete(oldest);
    }

    return entry;
  }

  async build(source, record, key) {
    let src = null;
    let bytes = 0;

    try {
      const image = await this.provider.generate(source, this.dimensions, () =>
        [...record.jobs].some((job) => this.wanted(job))
      );

      if (![...record.jobs].some((job) => this.wanted(job))) return null;
      bytes = image.bytes.length + image.width * image.height * 4;
      if (bytes <= this.maxBytes) src = this.createUrl(image.bytes);
      else bytes = 0;
    } catch (_error) {
      if (![...record.jobs].some((job) => this.wanted(job))) return null;
      // Cache a failed fingerprint; no automatic retry loop.
    }

    return this.remember(key, { src, bytes, clients: new Set() });
  }

  async run(job) {
    try {
      if (!this.wanted(job)) return;
      const source = await this.provider.inspect(job.item, job.context);

      if (!this.wanted(job)) return;
      const key = JSON.stringify([
        source.path,
        source.mtimeMs,
        source.size,
        source.ctimeMs,
        source.ino,
        this.dimensions.width,
        this.dimensions.height,
        source.identity,
      ]);
      let entry = this.cache.get(key);

      if (entry) {
        this.cache.delete(key);
        this.cache.set(key, entry);
      } else {
        let record = this.inflight.get(key);

        if (!record) {
          record = { jobs: new Set([job]) };
          this.inflight.set(key, record);
          record.promise = this.build(source, record, key).finally(() => {
            this.inflight.delete(key);
          });
        } else record.jobs.add(job);
        entry = await record.promise;
      }

      if (!entry || this.cache.get(key) !== entry) return;
      job.clients.forEach((client) => {
        if (this.current(client)) {
          Object.assign(client, { entry });
          entry.clients.add(client);
          this.notify(client, entry.src);
        }
      });
    } catch (_error) {
      job.failureKeys.forEach((key) => this.failures.set(key, true));
      while (this.failures.size > 64)
        this.failures.delete(this.failures.keys().next().value);
    }
  }

  drain() {
    while (this.active < this.maxJobs && this.pending.size) {
      const [path, job] = this.pending.entries().next().value;

      this.pending.delete(path);
      job.started = true;
      this.running.set(path, job);
      this.active += 1;
      // Cancellation only removes consumers. A native job occupies its slot
      // until its promise actually settles, even when navigation makes it stale.
      this.run(job)
        .finally(() => {
          this.running.delete(path);
          this.active -= 1;
          this.drain();
          this.notifyCapacity();
        })
        .catch((error) => {
          this.lastError = error;
        });
    }
  }
}
