// The Hub: roster, file claims, inboxes and conflict negotiation.
// Everything here runs in plain code and costs zero tokens. Sessions only
// spend tokens when they call a hub tool or get a short notice.

import type { Awareness, Claim, HubMessage, Link, PromptRequest } from './protocol.js';

export interface HubSessionInfo {
  id: string;
  name: string;
  priority: number;
  familyId: string | null;
  awareness: Awareness;
  goal: string;
  status: string;
  activity: string;
  /** Helpers belong to a boss and stay out of everyone else's roster. */
  parentId?: string | null;
  /** Workspace (board) id. Sessions only know about their own workspace. */
  workspace?: string | null;
}

export interface HubDeps {
  sessions(): HubSessionInfo[];
  links(): Link[];
  limits(): {
    maxMessageChars: number;
    maxMessagesPerHour: number;
    maxNegotiationRounds: number;
    maxWakeChain?: number;
    maxWakesPerHour?: number;
  };
  /** Hand a message to a session. `wake` = start a turn if it's idle. */
  deliver(msg: HubMessage, wake: boolean): void;
  openPrompt(p: PromptRequest): void;
  closePrompt(requestId: string): void;
  claimsChanged(claims: Claim[]): void;
  messageLogged(msg: HubMessage): void;
  now?(): number;
  newId?(): string;
}

export type EditCheck =
  | { ok: true; preempted?: string }
  | { ok: false; reason: string };

interface Negotiation {
  id: string;
  path: string;
  requester: string;
  holder: string;
  requesterReason: string;
  round: number;
  choices: Map<string, { choice: 'yield' | 'insist'; note: string }>;
  promptId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

const NEGOTIATION_TIMEOUT_MS = 120_000;

export class Hub {
  private claims = new Map<string, Claim>();
  private waiters = new Map<string, Set<string>>();
  private inboxes = new Map<string, HubMessage[]>();
  private sent = new Map<string, number[]>();
  /** When each session was last woken by a message, for the wakes-per-hour cap. */
  private woken = new Map<string, number[]>();
  private negotiations = new Map<string, Negotiation>();
  readonly log: HubMessage[] = [];
  private seq = 0;

  constructor(private deps: HubDeps) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }
  private id(prefix: string) {
    return this.deps.newId ? this.deps.newId() : `${prefix}_${Date.now().toString(36)}${(this.seq++).toString(36)}`;
  }
  private info(id: string) {
    return this.deps.sessions().find((s) => s.id === id);
  }
  private nameOf(id: string) {
    return this.info(id)?.name ?? id;
  }

  // ---------- roster ----------

  /** Sessions `id` is allowed to know about, based on its awareness setting. */
  visibleTo(id: string): HubSessionInfo[] {
    const me = this.info(id);
    if (!me || me.awareness === 'solo') return [];
    // Another workspace is another board: nobody there is visible, whatever the awareness.
    const all = this.deps.sessions().filter((s) => s.id !== id && !s.parentId && (s.workspace ?? null) === (me.workspace ?? null));
    if (me.awareness === 'everyone') return all;
    const linked = new Set(
      this.deps
        .links()
        .filter((l) => l.a === id || l.b === id)
        .map((l) => (l.a === id ? l.b : l.a)),
    );
    return all.filter((s) => linked.has(s.id) || (me.familyId != null && s.familyId === me.familyId));
  }

  isLinked(a: string, b: string) {
    return this.deps.links().some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  }

  /** Compact roster text, one line per session. Meant to be cheap to read. */
  roster(id: string): string {
    const list = this.visibleTo(id);
    if (list.length === 0) return 'No other sessions are visible to you.';
    return list
      .map((s) => {
        const files = [...this.claims.values()].filter((c) => c.sessionId === s.id).map((c) => short(c.path));
        const link = this.isLinked(id, s.id) ? ' [linked]' : '';
        const goal = s.goal || s.activity || 'no status yet';
        return `- ${s.name} (id ${s.id}, p${s.priority}, ${s.status})${link}: ${goal}${files.length ? ` | holds ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}` : ''}`;
      })
      .join('\n');
  }

  // ---------- messages ----------

  /**
   * Send a message. It only starts a turn for the receiver (a "wake") when the
   * sender asks for it AND the wake chain and hourly wake caps allow it.
   * Otherwise it waits and gets slipped into the receiver's next step, which
   * costs almost nothing. Every wake is a full model turn that re-reads the
   * receiver's whole context, so this is where tokens get spent.
   *
   * `depth` is the wake depth of the sender's current turn (0 = the user
   * started it). A woken turn has depth+1, so A wakes B wakes A wakes B...
   * stops after maxWakeChain hops no matter what the models do.
   */
  send(
    from: string,
    to: string,
    text: string,
    opts: { wake?: boolean; depth?: number } = {},
  ): { ok: boolean; error?: string; woke?: boolean; held?: string } {
    const { maxMessageChars, maxMessagesPerHour } = this.deps.limits();
    if (!this.visibleTo(from).some((s) => s.id === to)) {
      return { ok: false, error: `You can't message ${to}: not visible to you. Call hub_roster to see who you can reach.` };
    }
    const hourAgo = this.now() - 3_600_000;
    const stamps = (this.sent.get(from) ?? []).filter((t) => t > hourAgo);
    if (stamps.length >= maxMessagesPerHour) {
      return { ok: false, error: `Message limit reached (${maxMessagesPerHour}/hour). Keep working and try later.` };
    }
    stamps.push(this.now());
    this.sent.set(from, stamps);
    const body = text.length > maxMessageChars ? text.slice(0, maxMessageChars - 1) + '…' : text;
    const depth = (opts.depth ?? 0) + 1;
    let wake = !!opts.wake;
    let held: string | undefined;
    if (wake) held = this.wakeBlocker(to, depth);
    if (held) wake = false;
    if (wake) this.woken.set(to, [...(this.woken.get(to) ?? []).filter((t) => t > hourAgo), this.now()]);
    this.push({ id: this.id('m'), ts: this.now(), from, to, text: body, kind: 'message', woke: wake, depth }, wake);
    return { ok: true, woke: wake, held };
  }

  /** Why a wake isn't allowed right now, or undefined if it is. */
  private wakeBlocker(to: string, depth: number): string | undefined {
    const { maxWakeChain = 2, maxWakesPerHour = 8 } = this.deps.limits();
    if (depth > maxWakeChain) return 'wake chain limit';
    const hourAgo = this.now() - 3_600_000;
    const recent = (this.woken.get(to) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= maxWakesPerHour) return 'hourly wake limit';
    return undefined;
  }

  private notice(to: string, text: string, wake = false, kind: HubMessage['kind'] = 'notice') {
    this.push({ id: this.id('m'), ts: this.now(), from: 'hub', to, text, kind }, wake);
  }

  private push(msg: HubMessage, wake: boolean) {
    const box = this.inboxes.get(msg.to) ?? [];
    box.push(msg);
    this.inboxes.set(msg.to, box);
    this.log.push(msg);
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
    this.deps.messageLogged(msg);
    this.deps.deliver(msg, wake);
  }

  /** Unread messages for a session. Reading marks them read. */
  inbox(id: string): HubMessage[] {
    const box = this.inboxes.get(id) ?? [];
    this.inboxes.set(id, []);
    return box;
  }

  unreadCount(id: string) {
    return this.inboxes.get(id)?.length ?? 0;
  }

  // ---------- claims ----------

  allClaims(): Claim[] {
    return [...this.claims.values()];
  }

  holder(path: string) {
    return this.claims.get(path)?.sessionId ?? null;
  }

  private setClaim(path: string, sessionId: string, reason: string) {
    this.claims.set(path, { path, sessionId, reason, since: this.now() });
  }

  /**
   * Called before every file edit. Free file = claimed silently.
   * Busy file = settled by priority, or a negotiation when priorities match.
   */
  requestEdit(sessionId: string, path: string, reason = ''): EditCheck {
    const current = this.claims.get(path);
    if (!current || current.sessionId === sessionId || !this.info(current.sessionId)) {
      this.setClaim(path, sessionId, reason || current?.reason || 'editing');
      this.deps.claimsChanged(this.allClaims());
      return { ok: true };
    }
    const me = this.info(sessionId)!;
    const other = this.info(current.sessionId)!;
    const file = short(path);

    // Already negotiating over this file?
    const open = [...this.negotiations.values()].find((n) => !n.done && n.path === path);
    if (open) {
      return {
        ok: false,
        reason: `${file} is under negotiation (${open.id}) between ${this.nameOf(open.requester)} and ${this.nameOf(open.holder)}. Work on something else and retry after you get a notice.`,
      };
    }

    if (me.priority > other.priority) {
      // Higher priority takes the file right away.
      this.setClaim(path, sessionId, reason || 'editing');
      this.deps.claimsChanged(this.allClaims());
      this.notice(
        other.id,
        `${me.name} (higher priority p${me.priority}) took over ${file}. Don't edit it until you get a notice that it's free. Re-read it before editing again.`,
      );
      this.addWaiter(path, other.id);
      return { ok: true, preempted: other.id };
    }

    if (me.priority < other.priority) {
      this.addWaiter(path, sessionId);
      return {
        ok: false,
        reason: `${file} is being edited by ${other.name} (higher priority p${other.priority}, reason: ${current.reason}). You're queued and will get a notice when it's free. Work on something else meanwhile.`,
      };
    }

    // Same priority: negotiate, or ask the user if someone can't negotiate.
    const neg = this.startNegotiation(path, sessionId, current.sessionId, reason);
    this.addWaiter(path, sessionId);
    if (me.awareness === 'solo' || other.awareness === 'solo') {
      this.askUser(neg);
      return {
        ok: false,
        reason: `${file} is being edited by another session with the same priority. The user has been asked who goes first. Work on something else and retry after you get a notice.`,
      };
    }
    return {
      ok: false,
      reason: `${file} is being edited by ${other.name} (same priority, reason: ${current.reason}). A negotiation ${neg.id} has started: call hub_negotiate with "yield" or "insist" and a one-line note, then work on something else until you get a notice.`,
    };
  }

  claim(sessionId: string, paths: string[], reason: string) {
    return paths.map((p) => ({ path: p, result: this.requestEdit(sessionId, p, reason) }));
  }

  release(sessionId: string, paths?: string[]) {
    const mine = [...this.claims.values()].filter((c) => c.sessionId === sessionId && (!paths || paths.includes(c.path)));
    for (const c of mine) this.claims.delete(c.path);
    if (mine.length) this.deps.claimsChanged(this.allClaims());
    for (const c of mine) {
      // Releasing a file that's under negotiation settles it for the other side.
      const neg = [...this.negotiations.values()].find((n) => !n.done && n.path === c.path);
      if (neg) {
        const other = neg.holder === sessionId ? neg.requester : neg.holder;
        neg.done = true;
        if (neg.timer) clearTimeout(neg.timer);
        if (neg.promptId) this.deps.closePrompt(neg.promptId);
        this.waiters.get(c.path)?.delete(sessionId);
        if (this.info(other)) {
          this.waiters.get(c.path)?.delete(other);
          this.setClaim(c.path, other, 'editing');
          this.deps.claimsChanged(this.allClaims());
          this.notice(other, `You got ${short(c.path)} (${this.nameOf(sessionId)} finished with it). Re-read it, then go ahead.`, true);
        }
      }
      this.wakeWaiters(c.path);
    }
    return mine.map((c) => c.path);
  }

  /** Session went away: drop claims, waiters, negotiations. */
  forget(sessionId: string) {
    this.release(sessionId);
    for (const set of this.waiters.values()) set.delete(sessionId);
    for (const n of this.negotiations.values()) {
      if (!n.done && (n.requester === sessionId || n.holder === sessionId)) {
        const winner = n.requester === sessionId ? n.holder : n.requester;
        this.finish(n, winner, 'the other session stopped');
      }
    }
    this.inboxes.delete(sessionId);
  }

  private addWaiter(path: string, sessionId: string) {
    const set = this.waiters.get(path) ?? new Set();
    set.add(sessionId);
    this.waiters.set(path, set);
  }

  private wakeWaiters(path: string) {
    const set = this.waiters.get(path);
    if (!set || set.size === 0) return;
    this.waiters.delete(path);
    for (const id of set) {
      if (this.info(id)) this.notice(id, `${short(path)} is free now. You can edit it (re-read it first, it may have changed).`, true);
    }
  }

  // ---------- negotiation ----------

  private startNegotiation(path: string, requester: string, holder: string, requesterReason: string): Negotiation {
    const neg: Negotiation = {
      id: this.id('neg'),
      path,
      requester,
      holder,
      requesterReason: requesterReason || 'editing',
      round: 1,
      choices: new Map(),
      promptId: null,
      timer: null,
      done: false,
    };
    this.negotiations.set(neg.id, neg);
    const reqInfo = this.info(requester)!;
    const holdInfo = this.info(holder)!;
    const holdReason = this.claims.get(path)?.reason ?? 'editing';
    const file = short(path);
    if (reqInfo.awareness !== 'solo' && holdInfo.awareness !== 'solo') {
      this.notice(
        holder,
        `Negotiation ${neg.id}: ${reqInfo.name} wants ${file}, which you hold (${holdReason}). Same priority. Their goal: ${reqInfo.goal || neg.requesterReason}. Call hub_negotiate("${neg.id}", "yield" or "insist", one-line note). Yield if you're nearly done or their work matters more.`,
        true,
        'negotiation',
      );
      neg.timer = setTimeout(() => this.askUser(neg), NEGOTIATION_TIMEOUT_MS);
      (neg.timer as { unref?: () => void }).unref?.();
    }
    return neg;
  }

  negotiate(sessionId: string, negId: string, choice: 'yield' | 'insist', note: string): string {
    const neg = this.negotiations.get(negId);
    if (!neg || neg.done) return `Negotiation ${negId} is already settled.`;
    if (sessionId !== neg.requester && sessionId !== neg.holder) return `You're not part of ${negId}.`;
    neg.choices.set(sessionId, { choice, note: note.slice(0, 200) });
    const other = sessionId === neg.requester ? neg.holder : neg.requester;

    if (choice === 'yield') {
      this.finish(neg, other, `${this.nameOf(sessionId)} yielded: ${note}`);
      return `You yielded ${short(neg.path)} to ${this.nameOf(other)}.`;
    }
    const otherChoice = neg.choices.get(other);
    if (!otherChoice) {
      this.notice(other, `${this.nameOf(sessionId)} insists on ${short(neg.path)} (${neg.id}): "${note}". Reply with hub_negotiate.`, true, 'negotiation');
      return `Noted. Waiting for ${this.nameOf(other)} to answer.`;
    }
    if (otherChoice.choice === 'insist') {
      if (neg.round >= this.deps.limits().maxNegotiationRounds) {
        this.askUser(neg);
        return `Both sides insist. The user has been asked to decide. Work on something else meanwhile.`;
      }
      neg.round += 1;
      neg.choices.clear();
      for (const sid of [neg.requester, neg.holder]) {
        const theirs = sid === sessionId ? otherChoice.note : note;
        this.notice(sid, `Round ${neg.round} of ${neg.id}: both insisted. Their note: "${theirs}". Answer again with hub_negotiate. If still tied, the user decides.`, true, 'negotiation');
      }
      return `Both insisted, starting round ${neg.round}.`;
    }
    return 'Noted.';
  }

  private askUser(neg: Negotiation) {
    if (neg.done || neg.promptId) return;
    if (neg.timer) clearTimeout(neg.timer);
    neg.promptId = this.id('p');
    const notes = [...neg.choices.entries()].map(([sid, c]) => `${this.nameOf(sid)}: ${c.note}`).join(' · ');
    this.deps.openPrompt({
      kind: 'negotiation',
      requestId: neg.promptId,
      sessionId: neg.requester,
      otherId: neg.holder,
      path: neg.path,
      title: `${this.nameOf(neg.requester)} and ${this.nameOf(neg.holder)} both want ${short(neg.path)}`,
      detail: notes || 'Same priority, they could not settle it themselves.',
    });
  }

  /** The user picked a winner from the island. */
  decide(promptId: string, winner: string) {
    const neg = [...this.negotiations.values()].find((n) => n.promptId === promptId);
    if (!neg) return;
    this.finish(neg, winner, 'the user decided');
  }

  private finish(neg: Negotiation, winner: string, why: string) {
    if (neg.done) return;
    neg.done = true;
    if (neg.timer) clearTimeout(neg.timer);
    if (neg.promptId) this.deps.closePrompt(neg.promptId);
    const loser = winner === neg.requester ? neg.holder : neg.requester;
    const file = short(neg.path);
    if (this.info(winner)) {
      this.setClaim(neg.path, winner, winner === neg.requester ? neg.requesterReason : this.claims.get(neg.path)?.reason ?? 'editing');
      this.deps.claimsChanged(this.allClaims());
      this.waiters.get(neg.path)?.delete(winner);
      this.notice(winner, `You got ${file} (${why}). Re-read it, then go ahead.`, true);
    }
    if (this.info(loser)) {
      this.addWaiter(neg.path, loser);
      this.notice(loser, `${this.nameOf(winner)} has ${file} now (${why}). Don't edit it until you get a notice that it's free.`, false);
    }
  }

  openNegotiations() {
    return [...this.negotiations.values()].filter((n) => !n.done).map((n) => ({ id: n.id, path: n.path, requester: n.requester, holder: n.holder, round: n.round }));
  }
}

export function short(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}
