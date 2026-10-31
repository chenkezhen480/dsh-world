import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-agent-loop';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import '../hostContract.ts';
import { errorText, Faults } from '../faults.ts';
import { keepSelfCopy } from '../self.ts';
import { formatLocalTime } from '../timeContext.ts';
import { inWorld } from '../sourceArchive.ts';
import type { WorldConfig } from '../types.ts';
import { homeTitle, roomTitle, worldNames } from '../worldPrompt.ts';
import { admit, reassembleOnChange } from '../worldScope.ts';
import { budgetText, cancelReply, greetingText, checkReply, earlyStopText, nextLocalTime, nextReview, planReply, resolveAlarmTime, reviewText, wakeText } from './alarm.ts';
import { summarizeSince } from './activity.ts';
import { createAlarmTimer, realTimers, type LifeTimers } from './alarmTimer.ts';
import { createEarlyStopWatch } from './earlyStop.ts';
import { createHome } from './home.ts';
import type { LifeHost } from './host.ts';
import { createJournal } from './journal.ts';
import { stepCost } from './pricing.ts';
import type { LifeStore } from './lifeStore.ts';
import { exampleTime, readAlarmMessages } from './messages.ts';
import type { Notifier } from './notify.ts';
import { createToolRegistry } from './toolRegistry.ts';
import { alarmDescriptions, lifeTools } from './tools.ts';
import { createRecallIndex } from './recall.ts';
import { createStatusBoard } from './status.ts';
import type { PhotoStore } from './photos.ts';
import { photoTools } from './photoTools.ts';
import type { Alarm, Greeting, LifeOptions, PendingWake, Review, WakeRecord } from './types.ts';

/** How long a word may sit in her home without its turn starting a step before the console says so. */
const STALL_MINUTES = 5;
const withValue = <K extends string>(key: K, value: string | undefined) => (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;
export interface LifeDeps {
  ctx: Context; config: WorldConfig; options: LifeOptions; store: LifeStore; host: LifeHost; notifier: Notifier; clock?: () => Date; timers?: LifeTimers;
  /** CNY her home may spend a day; undefined or absent is no limit. */
  dailyBudget?: () => number | undefined;
  /** Called once each evening look back has been handed to her home (not for alarms or greetings, and not when delivery failed). */
  afterReview?: () => void;
  /** Read-only facts appended after the user's alarm template is rendered. */
  alarmContext?: (now: Date) => string | undefined;
  photos?: () => PhotoStore;
  /** Her room's workspace; the life line reaches only its sessions. Absent, every session of hers. */
  inWorkspace?: (sessionId: string) => boolean;
}

/**
 * Her life line: one pending alarm, kept in life.json and delivered into her home with `agent.steer`, the
 * tools she sets it with, the home itself, a new home's greeting and the evening look back. The parts live in
 * their own modules; this wires them.
 */
export function createLifeRuntime(deps: LifeDeps) {
  const { ctx, config, options, store, host } = deps;
  const { timeZone } = options;
  const names = worldNames(config);
  const clock = deps.clock ?? (() => new Date());
  const timers = deps.timers ?? realTimers;
  const faults = new Faults();
  /** Her long-term memory, searched rather than copied: the index points at the archive, the diary and the activity log. */
  const recall = createRecallIndex({ worldDir: options.worldDir, diaryDir: options.diaryDir, timeZone, selfName: names.companion, partnerName: names.partner });
  /** The strip in the console: her mood, her energy, today's rice. Written by her, read by everyone. */
  const status = createStatusBoard({ worldDir: options.worldDir, now: clock });
  const includes = (session: Agent['session']) => inWorld(session, config, deps.inWorkspace);
  const disposers: (() => void)[] = [];
  const state = store.read();
  let stopped = false;
  let delivery: Promise<void> | undefined;

  /** Bookkeeping after the fact: a failure is a fault, never a broken turn. */
  function record(work: () => void): void {
    try { work(); faults.clear('state'); }
    catch (error) { faults.set('state', `生活状态没能保存：${errorText(error)}`); ctx.logger.error(error); }
  }
  /** Her alarm wording, read when it is used; an unreadable template is a fault and the shipped one is used. */
  function alarmMessages() {
    const messages = readAlarmMessages(options.alarmFile);
    if (messages.error) faults.set('alarm-template', messages.error); else faults.clear('alarm-template');
    return messages;
  }
  const templateValues = () => ({ name: names.companion, partner: names.partner, homeTitle: homeTitle(names), timeZone, fallbackWakeTime: options.fallbackWakeTime, example: exampleTime(timeZone) });
  /**
   * What she actually did between setting this alarm and hearing it, in one line.
   *
   * Read from the activity log rather than from her own account of the time, so the alarm can contradict
   * her note: "歇着" plus forty tool calls is a different sentence from "歇着" plus none. Both days the
   * alarm could straddle are read, because a plan set at 23:50 and heard at 00:30 has its work split.
   */
  const didSince = (alarm: Alarm, now: Date): string => {
    const dayOf = (at: string | Date) => formatLocalTime(new Date(at), timeZone).slice(0, 10);
    const days = [...new Set([dayOf(alarm.setAt), dayOf(now)])];
    const records = days.flatMap(each => store.activity(each)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return summarizeSince(records, alarm.setAt, now);
  };
  const lifeMessage = (text: string) => createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text }] });
  const say = (agent: Agent, message: string | UserMessage) => {
    admit(includes, agent).steer(typeof message === 'string' ? lifeMessage(message) : message);
    return ctx.sessions.flush(agent.session);
  };

  // Delivery is a step that starts with the word, not a steer that did not throw: a turn can take the word out
  // of the inbox and never reach its first step (the host still starting, the app closed), and the word is then
  // lost. The host logs the word as a `user/message` only after its step has started, so that event is the proof.
  /** Whether the word is still queued in her home, to be taken by a coming step. */
  const queued = (agent: Agent, id: string) => [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message.id === id);
  let stallTimer: unknown;
  function watchStall(pending: PendingWake): void {
    if (stallTimer !== undefined) timers.clear(stallTimer);
    stallTimer = timers.set(() => {
      stallTimer = undefined;
      if (stopped || state.delivering?.messageId !== pending.messageId) return;
      faults.set('stall', `${pending.what}在 ${formatLocalTime(new Date(pending.sentAt), timeZone).slice(11, 16)} 送进了家，${STALL_MINUTES} 分钟了这一轮还没开始`);
    }, Math.max(0, Date.parse(pending.sentAt) + STALL_MINUTES * 60_000 - clock().getTime()));
  }
  function settle(): PendingWake | undefined {
    const pending = state.delivering;
    delete state.delivering;
    if (stallTimer !== undefined) { timers.clear(stallTimer); stallTimer = undefined; }
    faults.clear('stall');
    return pending;
  }
  function confirmed(): void {
    const pending = settle();
    if (!pending) return;
    const now = clock();
    faults.clear('delivery');
    record(() => { store.write(state); store.appendWake({ scheduledAt: pending.scheduledAt, deliveredAt: now.toISOString(), source: pending.source, lateMs: Math.max(0, now.getTime() - Date.parse(pending.scheduledAt)) }); });
    timer.reset();
  }
  /** Back on the schedule: her own alarm unless a plan of hers replaced it meanwhile, otherwise as it was. */
  function neverRan(why: string): void {
    const pending = settle();
    if (!pending) return;
    const { job } = pending;
    if ('alarm' in job) { if (!state.alarm || state.alarm.source === 'fallback') state.alarm = job.alarm; }
    else if ('review' in job) state.review = job.review;
    else state.greeting ??= job.greeting;
    record(() => store.write(state));
    faults.set('delivery', `${pending.what}没开始，${timer.failed()} 分钟后重新送：${why}`);
  }
  /**
   * After a restart: the word sent last time is in the log (it ran; counted now), still queued or in a live turn
   * (watched as if just sent), or gone with the turn that took it (sent again).
   */
  function reconcile(agent: Agent): void {
    const pending = state.delivering;
    if (!pending) return;
    if (pending.sessionId !== agent.id) return neverRan('家换过了');
    const { session } = agent;
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(SessionSeq(seq));
      if (event?.type === 'user/message' && event.data.id === pending.messageId) return confirmed();
    }
    if (queued(agent, pending.messageId) || agent.status === 'running') return watchStall(pending);
    neverRan('上次那一轮没开始就中断了');
  }
  /** Written before the steer, so a crash right after it still finds the word; unsaved, it is still sent and watched. */
  function expect(agent: Agent, message: UserMessage, what: string, scheduledAt: string, source: PendingWake['source'], job: PendingWake['job'], now: Date): void {
    const pending: PendingWake = { messageId: message.id, sessionId: agent.id, sentAt: now.toISOString(), what, scheduledAt, source, job };
    state.delivering = pending;
    record(() => store.write(state));
    watchStall(pending);
  }

  // Her alarm.
  // What is delivered next: a new home's greeting first, then whichever of the look back and her alarm is due sooner.
  type Job = { kind: 'greeting'; at: string; greeting: Greeting } | { kind: 'review'; at: string; review: Review } | { kind: 'alarm'; at: string; alarm: Alarm };
  function nextJob(): Job | undefined {
    const { greeting, review, alarm } = state;
    if (greeting) return { kind: 'greeting', at: greeting.at, greeting };
    if (review && (!alarm || Date.parse(review.at) <= Date.parse(alarm.at))) return { kind: 'review', at: review.at, review };
    return alarm && { kind: 'alarm', at: alarm.at, alarm };
  }
  const timer = createAlarmTimer({ clock, timers, dueAlarm: () => nextJob()?.at, fire: () => void deliver() });
  const morning = (now: Date): Alarm => ({ at: nextLocalTime(now, options.fallbackWakeTime, timeZone).toISOString(), note: '', setAt: now.toISOString(), source: 'fallback' });
  /** A new alarm replaces a failing one, so its backoff and fault go with it. Saved or not, it is armed. */
  function setAlarm(alarm: Alarm): void {
    if (stopped) return;
    state.alarm = alarm; faults.clear('delivery', 'alarm');
    try { store.write(state); }
    catch (error) { faults.set('alarm', `闹钟没能保存：${errorText(error)}`); throw error; }
    finally { timer.reset(); }
  }
  /** Nothing pending means resting until the next morning. Unsaved, it still rings while the app keeps running. */
  function fallbackAlarm(): void {
    if (state.alarm || state.greeting || stopped) return;
    try { setAlarm(morning(clock())); }
    catch (error) { faults.set('alarm', `断线保护闹钟没能保存：${errorText(error)}`); ctx.logger.error(error); }
  }
  function planNext(input: { at?: string; after_minutes?: number }, note: string): string {
    if (stopped) throw new Error('生活线已停止');
    const now = clock();
    const at = resolveAlarmTime(input, now, timeZone);
    const replaced = state.alarm;
    setAlarm({ at: at.toISOString(), note: note.trim(), setAt: now.toISOString(), source: 'plan' });
    return planReply(at, replaced, timeZone);
  }
  const checkAlarm = () => checkReply(state.alarm, clock(), timeZone);
  /** Back to the morning fallback, exactly as if she had set nothing. */
  function cancelAlarm(): string {
    if (stopped) throw new Error('生活线已停止');
    const cancelled = state.alarm;
    if (cancelled?.source === 'plan') setAlarm(morning(clock())); else fallbackAlarm();
    return cancelReply(cancelled, state.alarm, timeZone);
  }

  // Delivery: one at a time, the next only once the last started a step; a failure backs off, and a newer alarm keeps its own time.
  function deliver(): Promise<void> {
    const job = nextJob();
    if (stopped || !job || state.delivering) return delivery ?? Promise.resolve();
    return delivery ??= (job.kind === 'alarm' ? send(job.alarm) : job.kind === 'review' ? lookBack(job.review) : greet(job.greeting)).finally(() => { delivery = undefined; });
  }
  /**
   * A message of the plugin's own, taken off the schedule while it is sent and put back if it fails: it backs
   * off like an alarm, and its turn is never asked about as an early stop. It counts once its turn starts a step.
   */
  async function sayOwn(what: string, source: WakeRecord['source'], scheduledAt: string, job: PendingWake['job'], take: () => void, putBack: () => void, text: (now: Date) => string, delivered?: () => void): Promise<void> {
    try {
      const agent = await home.open();
      if (stopped) return;
      take();
      const now = clock();
      const message = lifeMessage(text(now));
      expect(agent, message, what, scheduledAt, source, job, now);
      earlyStop.startsOwnTurn();
      await say(agent, message);
      if (!stopped) delivered?.();
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      earlyStop.ownTurnFailed();
      settle(); putBack();
      record(() => store.write(state));
      faults.set('delivery', `${what}没送到，${timer.failed()} 分钟后重试：${errorText(error)}`);
      return;
    }
    if (stopped) return;
    faults.clear('home');
    timer.arm();
  }
  /**
   * A new home's first words, so it has a turn (the host lists no session without one) and she knows she moved;
   * or the word that her world has started again.
   */
  const greet = (greeting: Greeting) => sayOwn(greeting.kind === 'arrival' ? '新家的第一句话' : '重新开始的那句话', greeting.kind === 'arrival' ? 'first' : 'return', greeting.at, { greeting },
    () => { delete state.greeting; }, () => { state.greeting ??= greeting; },
    () => greetingText(greeting.kind, timeZone, options.fallbackWakeTime, alarmMessages(), templateValues()));
  /** The evening look back on her day; her 我是谁 is kept as it was, so she can rewrite it freely. */
  function lookBack(review: Review): Promise<void> {
    let snapshot: string | undefined;
    const take = () => {
      try { snapshot = keepSelfCopy(options.selfFile, review.day); faults.clear('snapshot'); }
      catch (error) { faults.set('snapshot', `我是谁没能留底：${errorText(error)}`); ctx.logger.error(error); }
      state.review = nextReview(clock(), timeZone);
    };
    const existing = (dir: string) => { const file = join(options.worldDir, dir, `${review.day}.jsonl`); return existsSync(file) ? file : undefined; };
    return sayOwn('每日回顾', 'review', review.at, { review }, take, () => { state.review = review; }, now => reviewText(review, now, {
      ...withValue('conversations', existing('conversations')), ...withValue('activity', existing('activity')), ...withValue('snapshot', snapshot),
      diaryDir: options.diaryDir, selfFile: options.selfFile,
    }, timeZone, options.fallbackWakeTime, alarmMessages(), templateValues()), () => deps.afterReview?.());
  }
  async function send(alarm: Alarm): Promise<void> {
    try {
      // Resolve (or rebuild) the home first: a rebuilt home must still see this alarm as pending.
      const agent = await home.open();
      if (stopped) return;
      if (state.alarm !== alarm) { timer.arm(); return; }
      // Cleared before steering, so a turn that ends quickly already sees "no alarm" and gets the fallback.
      delete state.alarm;
      const now = clock();
      const text = wakeText(alarm, now, timeZone, options.fallbackWakeTime, alarmMessages(), { ...templateValues(), did: alarm.source === 'fallback' ? '' : didSince(alarm, now) });
      const context = deps.alarmContext?.(now);
      const message = lifeMessage(context ? `${text}\n\n${context}` : text);
      expect(agent, message, '闹钟', alarm.at, alarm.source, { alarm }, now);
      await say(agent, message);
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      settle();
      if (state.alarm && state.alarm !== alarm) { record(() => store.write(state)); faults.set('delivery', `闹钟送达失败：${errorText(error)}`); timer.arm(); return; }
      state.alarm = alarm;
      record(() => store.write(state));
      faults.set('delivery', `闹钟送达失败，${timer.failed()} 分钟后重试：${errorText(error)}`);
      return;
    }
    if (stopped) return;
    // Steered and durable; it counts as delivered once her home starts a step with it (see `confirmed`).
    faults.clear('home');
    timer.arm();
  }

  // Stopping early: asked once per alarm whether she is done.
  const earlyStop = createEarlyStopWatch();
  function askIfDoneEarly(completed: boolean): void {
    const now = clock(); const alarm = state.alarm;
    if (!earlyStop.turnEnded(completed, alarm, now) || stopped) return;
    alarm.nudged = true;
    record(() => store.write(state));
    earlyStop.startsOwnTurn();
    const text = earlyStopText(alarm, now, timeZone, alarmMessages(), templateValues());
    void home.open().then(agent => stopped ? undefined : say(agent, text)).catch(error => { earlyStop.ownTurnFailed(); ctx.logger.error(error); });
  }

  // What her home spends: each model step priced as it lands; past the daily budget she is told once that day.
  function spent(usage: Parameters<typeof stepCost>[0], model: string): void {
    const now = clock(); const day = formatLocalTime(now, timeZone).slice(0, 10);
    const spend = state.spend?.day === day ? state.spend : (state.spend = { day, yuan: 0 });
    spend.yuan += stepCost(usage, model, now);
    const budget = deps.dailyBudget?.();
    const remind = budget !== undefined && spend.yuan >= budget && !spend.reminded;
    if (remind) spend.reminded = true;
    record(() => store.write(state));
    if (!remind) return;
    const text = budgetText(spend.yuan, budget, alarmMessages(), templateValues());
    void home.open().then(agent => {
      if (stopped) return;
      // Into the running turn at its next step, or a turn of its own that is not asked about.
      if (agent.status !== 'running') earlyStop.startsOwnTurn();
      return say(agent, text);
    }).catch(error => { earlyStop.ownTurnFailed(); ctx.logger.error(error); });
  }

  // Her tools and her home.
  const notifier: Notifier = {
    ...(deps.notifier.toast ? { toast: (title: string, body: string) => faults.track('toast', '系统通知没送到', () => deps.notifier.toast!(title, body)) } : {}),
    outlets: deps.notifier.outlets.map(outlet => ({ ...outlet, send: push => faults.track(`outlet:${outlet.name}`, `${outlet.name}没送到`, () => outlet.send(push)) })),
  };
  const tools = createToolRegistry({
    faults, logger: ctx.logger,
    inWorld: agent => !stopped && includes(agent.session),
    isHome: agent => agent.id === state.homeSessionId,
    tools: agent => [
      ...lifeTools({ planNext, checkAlarm, cancelAlarm, notifier, names, recall: input => recall.search(input), setStatus: input => status.write(input), origin: () => { try { return host.origin(); } catch { return undefined; } }, descriptions: alarmDescriptions(alarmMessages(), templateValues()) }),
      ...deps.photos ? photoTools({ agent, store: deps.photos, attachments: () => ctx.get('attachments') as AttachmentStore | undefined, inside: () => !stopped && agent.id === state.homeSessionId && includes(agent.session) }) : [],
    ],
  });
  const attach = (agent: Agent) => !stopped && includes(agent.session) ? tools.attach(agent) : tools.detach(agent);
  const home = createHome({
    host, roomDir: options.roomDir, agentPreset: config.agentPreset, title: homeTitle(names), roomTitle: roomTitle(names), faults, logger: ctx.logger,
    current: () => state.homeSessionId,
    // A new home greets her at once (the pending alarm moves in too and rings at its own time).
    moveIn(sessionId) {
      state.homeSessionId = sessionId;
      state.greeting = { at: clock().toISOString(), kind: 'arrival' };
      tools.releaseOldHomes();
      store.write(state);
    },
    opened: attach,
    inWorld: includes,
    stopped: () => stopped,
  });
  const journal = createJournal({ store, faults, roomDir: options.roomDir, logger: ctx.logger });

  /** `resumed`: started again from the console; unless an alarm of her own is pending, she is told she is back. */
  async function start(options: { resumed?: boolean } = {}): Promise<void> {
    disposers.push(
      ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined; }),
      reassembleOnChange(ctx, attach),
      ctx.on('agent/pre-step', ({ agent }, next) => { attach(agent); return next(); }, { prepend: true }),
      ctx.on('agent/disposed', ({ agent }) => tools.forget(agent)),
      ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
        attach(agent);
        // Her partner's words reach her at the next step, like being called while busy.
        if (!includes(agent.session) || agent.id !== state.homeSessionId || inserted.source.kind !== 'user' || agent.status !== 'running') return;
        if (!agent.inbox.nextTurn.some(queued => queued.id === inserted.id)) return;
        agent.inbox.remove(inserted.id); agent.steer(inserted);
      }),
      ctx.on('session/event', (session, event) => {
        if (!includes(session)) return;
        journal.world(session, event);
        if (session.id !== state.homeSessionId) return;
        journal.home(session, event);
        if (event.type === 'assistant/message' && event.data.usage) spent(event.data.usage, event.data.message.source.model);
        if (event.type === 'user/message' && event.data.source.kind === 'user') earlyStop.partnerSpoke();
        // Before the fallback below, so a word whose turn never ran goes back first.
        const pending = state.delivering;
        if (pending?.sessionId === session.id) {
          if (event.type === 'user/message' && event.data.id === pending.messageId) confirmed();
          else if (event.type === 'turn/end') {
            const agent = ctx.agents.get(session.id);
            if (!agent || !queued(agent, pending.messageId)) neverRan(`那一轮没开始就结束了（${event.data.reason.kind}）`);
          }
        }
        if (event.type !== 'turn/end') return;
        home.turnEnded(session.id);
        fallbackAlarm();
        // A stopped or failed turn is not her deciding she is done.
        askIfDoneEarly(event.data.reason.kind === 'completed');
      }),
    );
    for (const agent of ctx.agents.list()) attach(agent);
    if (!state.review) { state.review = nextReview(clock(), timeZone); record(() => store.write(state)); }
    try {
      const agent = await home.open(); faults.clear('home');
      reconcile(agent);
      // The morning fallback is the plugin's, not a plan of hers: starting again wakes her rather than leaving her asleep till then.
      if (options.resumed && !state.greeting && state.alarm?.source !== 'plan') { state.greeting = { at: clock().toISOString(), kind: 'return' }; record(() => store.write(state)); }
      // A restart with nothing scheduled and no turn to end would otherwise never wake her again.
      if (agent.status !== 'running') fallbackAlarm();
    } catch (error) { if (!stopped) { faults.set('home', `家打不开：${errorText(error)}`); ctx.logger.error(error); } }
    timer.arm();
  }
  function stop(): void {
    if (stopped) return;
    stopped = true;
    timer.stop();
    if (stallTimer !== undefined) { timers.clear(stallTimer); stallTimer = undefined; }
    for (const dispose of disposers.splice(0).reverse()) dispose();
    tools.clear();
    recall.close();
  }
  return {
    start, stop, planNext, checkAlarm, cancelAlarm, deliver,
    snapshot: () => ({ homeSessionId: state.homeSessionId, alarm: state.alarm, review: state.review, spend: state.spend, faults: faults.list(), herStatus: status.read() ?? null }),
    /** Resolves once no alarm delivery is in flight (its durability flush can outlast the turn it starts). */
    settled: async () => { while (delivery) await delivery; },
    home: () => home.open(),
    /** Whether this session is her home now; the world prompt gives the home its world line. */
    isHome: (sessionId: string) => !stopped && sessionId === state.homeSessionId,
  };
}
export type LifeRuntime = ReturnType<typeof createLifeRuntime>;
