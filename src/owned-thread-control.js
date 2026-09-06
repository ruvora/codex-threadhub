import { CodexControlPlane } from "./control-plane.js";

// A persistent observer must not also retain every completed thread's writer.
// Each acquired thread gets its own App Server process. Unknown outcomes retain
// their process for reconciliation; only observed terminal turns release it.
export class OwnedThreadControl extends CodexControlPlane {
  constructor(client, sessionFactory) {
    super(client);
    this.sessionFactory = sessionFactory;
    this.sessions = new Map();
    this.acquisitions = new Map();
    this.pendingAcquisitions = new Set();
    this.closing = false;
  }

  acquire(method, args) {
    if (this.closing) return Promise.reject(Object.assign(new Error("Thread control is closing"), { code: "THREAD_CONTROL_CLOSING" }));
    const pending = this.acquireSession(method, args);
    this.pendingAcquisitions.add(pending);
    pending.then(() => this.pendingAcquisitions.delete(pending), () => this.pendingAcquisitions.delete(pending));
    return pending;
  }

  async acquireSession(method, args) {
    const session = this.sessionFactory();
    const forward = (message) => this.client.emit("notification", message);
    session.client.on?.("notification", forward);
    session.detach = () => session.client.off?.("notification", forward);
    try {
      await session.control.connect();
      const agent = await session.control[method](...args);
      this.sessions.set(agent.id, session);
      return agent;
    } catch (error) {
      session.detach();
      await session.client.close();
      throw error;
    }
  }

  spawnAgent(options = {}) { return this.acquire("spawnAgent", [options]); }
  forkAgent(threadId, options = {}) { return this.acquire("forkAgent", [threadId, options]); }

  nameAgent(threadId, name) {
    return this.sessions.has(threadId)
      ? this.sessions.get(threadId).control.nameAgent(threadId, name)
      : super.nameAgent(threadId, name);
  }

  archiveAgent(threadId) {
    return this.sessions.has(threadId)
      ? this.sessions.get(threadId).control.archiveAgent(threadId)
      : super.archiveAgent(threadId);
  }

  async resumeAgent(threadId, options = {}) {
    if (this.sessions.has(threadId)) return this.sessions.get(threadId).control.resumeAgent(threadId, options);
    if (!this.acquisitions.has(threadId)) {
      const flight = this.acquire("resumeAgent", [threadId, options]).finally(() => this.acquisitions.delete(threadId));
      this.acquisitions.set(threadId, flight);
    }
    return this.acquisitions.get(threadId);
  }

  async releaseSession(threadId, session) {
    if (this.sessions.get(threadId) !== session) return;
    if (session.releasePromise) return session.releasePromise;
    session.releasePromise = (async () => {
      await session.client.close({ waitForExit: true });
      session.detach();
      if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
    })();
    try { await session.releasePromise; }
    finally { session.releasePromise = null; }
  }

  async runTask(threadId, prompt, options = {}) {
    if (!this.sessions.has(threadId)) await this.resumeAgent(threadId);
    const session = this.sessions.get(threadId);
    let terminal = false;
    try {
      const result = await session.control.runTask(threadId, prompt, options);
      terminal = ["completed", "failed", "interrupted"].includes(result.turn?.status?.type ?? result.turn?.status);
      return result;
    } finally {
      if (terminal) await this.releaseSession(threadId, session);
    }
  }

  async inspectAgent(threadId, options = {}) {
    const session = this.sessions.get(threadId);
    if (!session) return super.inspectAgent(threadId, options);
    const result = await session.control.inspectAgent(threadId, options);
    const last = result?.thread?.turns?.at(-1);
    if (options.includeTurns && session.control.activeTaskStreams?.size === 0
      && ["completed", "failed", "interrupted"].includes(last?.status?.type ?? last?.status)) {
      await this.releaseSession(threadId, session);
    }
    return result;
  }

  interruptTask(threadId, turnId) {
    return this.sessions.has(threadId)
      ? this.sessions.get(threadId).control.interruptTask(threadId, turnId)
      : super.interruptTask(threadId, turnId);
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.pendingAcquisitions]);
    await Promise.all([...this.sessions].map(([id, session]) => this.releaseSession(id, session)));
  }
}
