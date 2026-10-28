import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-loop';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-system-prompt';
import '../hostContract.ts';
import { errorText, Faults } from '../faults.ts';
import { compareSelf, keepSelfCopy, searchSelf } from '../self.ts';
import { createDiaryReader } from './diary.ts';
import { formatLocalTime } from '../timeContext.ts';
import { belongsToWorld } from '../sourceArchive.ts';
import type { WorldConfig } from '../types.ts';
import { homeTitle, roomTitle, worldNames } from '../worldPrompt.ts';
import { budgetText, cancelReply, greetingText, checkReply, earlyStopText, nextLocalTime, nextReview, planReply, resolveAlarmTime, reviewText, wakeText } from './alarm.ts';
import { summarizeSince } from './activity.ts';
import { createAlarmTimer, realTimers, type LifeTimers } from './alarmTimer.ts';
import { createEarlyStopWatch } from './earlyStop.ts';
import { createHome } from './home.ts';
import type { LifeHost } from './host.ts';
import { createJournal } from './journal.ts';
import { stepCost } from './pricing.ts';
import { createRoutineStore, type RoutineStore } from './routines.ts';
import { createPhotoStore, type PhotoStore } from './photos.ts';
import type { LifeStore } from './lifeStore.ts';
import { exampleTime, readAlarmMessages } from './messages.ts';
import type { Notifier } from './notify.ts';
import { createToolRegistry } from './toolRegistry.ts';
import { alarmDescriptions, lifeTools } from './tools.ts';
import type { Alarm, Greeting, LifeOptions, Review, WakeRecord } from './types.ts';

const withValue = <K extends string>(key: K, value: string | undefined) => (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;
export interface LifeDeps {
  ctx: Context; config: WorldConfig; options: LifeOptions; store: LifeStore; host: LifeHost; notifier: Notifier; clock?: () => Date; timers?: LifeTimers;
  /** CNY her home may spend a day; undefined or absent is no limit. */
  dailyBudget?: () => number | undefined;
  routines?: RoutineStore;
  attachments?: AttachmentStore;
  photos?: PhotoStore;
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
  const diary = createDiaryReader(options.diaryDir);
  const clock = deps.clock ?? (() => new Date());
  const faults = new Faults();
  const disposers: (() => void)[] = [];
  const state = store.read();
  let stopped = false;
  let delivery: Promise<void> | undefined;
  const photos = deps.photos ?? (deps.attachments ? createPhotoStore(options.worldDir, deps.attachments, clock) : undefined);
  let currentImages: ImageAttachmentRef[] = [];

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
  const say = (agent: Agent, text: string) => {
    agent.steer(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text }] }));
    return ctx.sessions.flush(agent.session);
  };
  const routineSummaryMessage = (): ReturnType<typeof createUserMessage> | undefined => {
    const pending = routines.takePendingSummary(clock());
    if (!pending.length) return undefined;
    const lines = pending.map(item => `- ${item.title}（${item.dueAt}）`);
    const more = routines.list().routines.some(item => item.enabled && item.dueAt && !item.surfacedAt && (!item.deferUntil || Date.parse(item.deferUntil) <= clock().getTime()));
    const summary = `本地习惯到期摘要（最多 5 条；只供你自行决定完成、延后、跳过或删除，不代表已经执行）：\n${lines.join('\n')}${more ? '\n- 还有更多待处理项，可用 routine_list 查看。' : ''}`;
    return createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: summary }] });
  };

  // Her alarm.
  // What is delivered next: a new home's greeting first, then whichever of the look back and her alarm is due sooner.
  type Job = { kind: 'greeting'; at: string; greeting: Greeting } | { kind: 'review'; at: string; review: Review } | { kind: 'alarm'; at: string; alarm: Alarm };
  function nextJob(): Job | undefined {
    const { greeting, review, alarm } = state;
    if (greeting) return { kind: 'greeting', at: greeting.at, greeting };
    if (review && (!alarm || Date.parse(review.at) <= Date.parse(alarm.at))) return { kind: 'review', at: review.at, review };
    return alarm && { kind: 'alarm', at: alarm.at, alarm };
  }
  const timer = createAlarmTimer({ clock, timers: deps.timers ?? realTimers, dueAlarm: () => nextJob()?.at, fire: () => void deliver() });
  const routines = deps.routines ?? createRoutineStore(options.worldDir, timeZone, clock);
  const routineTimer = createAlarmTimer({
    clock, timers: deps.timers ?? realTimers,
    dueAlarm: () => { const file = routines.list(); return file.enabled ? file.routines.filter(item => item.enabled).flatMap(item => [item.nextDueAt, item.deferUntil].filter((at): at is string => Boolean(at))).sort()[0] : undefined; },
    fire: () => { try { routines.collectDue(clock()); } catch (error) { ctx.logger.error(error); routineTimer.failed(); } finally { routineTimer.arm(); } },
  });
  const refreshRoutineTimer = () => routineTimer.reset();
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

  // Delivery: one at a time; a failure backs off, and a newer alarm keeps its own time.
  function deliver(): Promise<void> {
    const job = nextJob();
    if (stopped || !job) return delivery ?? Promise.resolve();
    return delivery ??= (job.kind === 'alarm' ? send(job.alarm) : job.kind === 'review' ? lookBack(job.review) : greet(job.greeting)).finally(() => { delivery = undefined; });
  }
  const wake = (source: WakeRecord['source'], scheduledAt: string, now: Date): WakeRecord => ({ scheduledAt, deliveredAt: now.toISOString(), source, lateMs: Math.max(0, now.getTime() - Date.parse(scheduledAt)) });
  /**
   * A message of the plugin's own, taken off the schedule while it is sent and put back if it fails: it backs
   * off like an alarm, and its turn is never asked about as an early stop.
   */
  async function sayOwn(what: string, source: WakeRecord['source'], scheduledAt: string, take: () => void, putBack: () => void, text: (now: Date) => string): Promise<void> {
    let now = clock();
    try {
      const agent = await home.open();
      if (stopped) return;
      take();
      now = clock();
      earlyStop.startsOwnTurn();
      await say(agent, text(now));
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      earlyStop.ownTurnFailed();
      putBack();
      faults.set('delivery', `${what}没送到，${timer.failed()} 分钟后重试：${errorText(error)}`);
      return;
    }
    if (stopped) return;
    faults.clear('delivery', 'home');
    record(() => { store.write(state); store.appendWake(wake(source, scheduledAt, now)); });
    timer.reset();
  }
  /**
   * A new home's first words, so it has a turn (the host lists no session without one) and she knows she moved;
   * or the word that her world has started again.
   */
  const greet = (greeting: Greeting) => sayOwn(greeting.kind === 'arrival' ? '新家的第一句话' : '重新开始的那句话', greeting.kind === 'arrival' ? 'first' : 'return', greeting.at,
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
    return sayOwn('每日回顾', 'review', review.at, take, () => { state.review = review; }, now => reviewText(review, now, {
      ...withValue('conversations', existing('conversations')), ...withValue('activity', existing('activity')), ...withValue('snapshot', snapshot),
      diaryDir: options.diaryDir, selfFile: options.selfFile,
    }, timeZone, options.fallbackWakeTime, alarmMessages(), templateValues()));
  }
  async function send(alarm: Alarm): Promise<void> {
    let now = clock();
    try {
      // Resolve (or rebuild) the home first: a rebuilt home must still see this alarm as pending.
      const agent = await home.open();
      if (stopped) return;
      if (state.alarm !== alarm) { timer.arm(); return; }
      // Cleared before steering, so a turn that ends quickly already sees "no alarm" and gets the fallback.
      delete state.alarm;
      now = clock();
      await say(agent, wakeText(alarm, now, timeZone, options.fallbackWakeTime, alarmMessages(), { ...templateValues(), did: alarm.source === 'fallback' ? '' : didSince(alarm, now) }));
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      if (state.alarm && state.alarm !== alarm) { faults.set('delivery', `闹钟送达失败：${errorText(error)}`); timer.arm(); return; }
      state.alarm = alarm;
      faults.set('delivery', `闹钟送达失败，${timer.failed()} 分钟后重试：${errorText(error)}`);
      return;
    }
    if (stopped) return;
    // Steered and durable: the alarm is delivered. Recording it may fail, but it is never sent again.
    faults.clear('delivery', 'home');
    record(() => {
      store.write(state);
      store.appendWake({ scheduledAt: alarm.at, deliveredAt: now.toISOString(), source: alarm.source, lateMs: Math.max(0, now.getTime() - Date.parse(alarm.at)) });
    });
    timer.reset();
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
  function spent(usage: Parameters<typeof stepCost>[0], model: string, sessionId: string): void {
    const now = clock(); const day = formatLocalTime(now, timeZone).slice(0, 10);
    const spend = state.spend?.day === day ? state.spend : (state.spend = { day, yuan: 0 });
    const yuan = stepCost(usage, model, now); spend.yuan += yuan;
    try {
      store.appendCost({ occurredAt: now.toISOString(), day, worldId: config.worldId, sessionId, model, inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens ?? 0, outputTokens: usage.outputTokens, yuan, source: 'home' });
      faults.clear('cost');
    } catch (error) { faults.set('cost', `成本记录写入失败：${errorText(error)}`); ctx.logger.error(error); }
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
    isHome: agent => agent.id === state.homeSessionId,
    tools: () => lifeTools({ planNext, checkAlarm, cancelAlarm, notifier, names, origin: () => { try { return host.origin(); } catch { return undefined; } }, descriptions: alarmDescriptions(alarmMessages(), templateValues()), searchDiary: diary.search, readDiary: diary.read, searchSelf: (query, limit) => searchSelf(options.selfFile, query, limit), compareSelf: (older, newer) => compareSelf(options.selfFile, older, newer), routines: {
      list: () => { const value = routines.list(); const now = clock().getTime(); return { ...value, routines: value.routines.slice(0, 100), pending: value.routines.filter(item => item.dueAt && (!item.deferUntil || Date.parse(item.deferUntil) <= now)).slice(0, 5).map(({ id, title, dueAt, note }) => ({ id, title, dueAt, note })) }; },
      add: input => { const value = routines.add(input); refreshRoutineTimer(); return value; },
      update: (id, patch) => { const value = routines.update(id, patch); refreshRoutineTimer(); return value; },
      pause: (id, paused) => { const value = routines.pause(id, paused); refreshRoutineTimer(); return value; },
      remove: id => { routines.remove(id); refreshRoutineTimer(); },
      handle: (id, decision, minutes) => { const value = routines.handle(id, decision, minutes); refreshRoutineTimer(); return value; },
    }, ...(photos ? { photos: {
      keep: async (index: number, description?: string, tags?: string[]) => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= currentImages.length) throw new Error('index 必须指向当前消息中的图片');
        return photos.keep(currentImages[index]!, description, tags);
      }, list: photos.list, forget: photos.forget,
    } } : {}) }),
  });
  const attach = (agent: Agent) => { if (!stopped && belongsToWorld(agent.session, config)) tools.attach(agent); };
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
    stopped: () => stopped,
  });
  const journal = createJournal({ store, faults, roomDir: options.roomDir, logger: ctx.logger });

  /** `resumed`: started again from the console; unless an alarm of her own is pending, she is told she is back. */
  async function start(options: { resumed?: boolean } = {}): Promise<void> {
    disposers.push(
      ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined; }),
      ctx.on('agent/disposed', ({ agent }) => tools.forget(agent)),
      ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
        // Her partner's words reach her at the next step, like being called while busy.
        if (agent.id !== state.homeSessionId || inserted.source.kind !== 'user' || agent.status !== 'running') return;
        if (!agent.inbox.nextTurn.some(queued => queued.id === inserted.id)) return;
        agent.inbox.remove(inserted.id); agent.steer(inserted);
      }),
      ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        const decision = await next();
        if (decision.kind !== 'enter' || signal.aborted || agent.id !== state.homeSessionId || !decision.messages.some(message => message.source.kind === 'user')) return decision;
        const summary = routineSummaryMessage();
        return summary ? { ...decision, messages: [summary, ...decision.messages] } : decision;
      }),
      ctx.on('session/event', (session, event) => {
        if (!belongsToWorld(session, config)) return;
        journal.world(session, event);
        if (session.id !== state.homeSessionId) return;
        journal.home(session, event);
        if (event.type === 'assistant/message' && event.data.usage) spent(event.data.usage, event.data.message.source.model, session.id);
        if (event.type === 'user/message' && event.data.source.kind === 'user') earlyStop.partnerSpoke();
        if (event.type === 'user/message' && event.data.source.kind === 'user') currentImages = event.data.content.flatMap(block => block.type === 'image' ? [block.attachment] : []);
        if (event.type !== 'turn/end') return;
        home.turnEnded(session.id);
        fallbackAlarm();
        // A stopped or failed turn is not her deciding she is done.
        askIfDoneEarly(event.data.reason.kind === 'completed');
        currentImages = [];
      }),
    );
    for (const agent of ctx.agents.list()) attach(agent);
    routines.collectDue(clock()); routineTimer.arm();
    if (!state.review) { state.review = nextReview(clock(), timeZone); record(() => store.write(state)); }
    try {
      const agent = await home.open(); faults.clear('home');
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
    routineTimer.stop();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    tools.clear();
  }
  return {
    start, stop, planNext, checkAlarm, cancelAlarm, deliver,
    snapshot: () => ({ homeSessionId: state.homeSessionId, alarm: state.alarm, review: state.review, spend: state.spend, routines: routines.list(), photos: photos?.list() ?? [], faults: faults.list() }),
    /** Resolves once no alarm delivery is in flight (its durability flush can outlast the turn it starts). */
    settled: async () => { while (delivery) await delivery; },
    home: () => home.open(),
    /** Whether this session is her home now; the world prompt gives the home its world line. */
    isHome: (sessionId: string) => !stopped && sessionId === state.homeSessionId,
    routines,
    photos,
    refreshRoutineTimer,
  };
}
export type LifeRuntime = ReturnType<typeof createLifeRuntime>;
