// src/ecosystem/computer/desktop/turns.ts
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { Recording } from './recording.ts';

/** What one desktop action hands back: short text, and the picture she acts on (`caption` when it is not a picture of now). */
export interface DesktopResult { text: string; image?: { data: Buffer; mediaType: ImageMediaType; caption?: string } }
export interface DesktopAction { at: string; action: string; app?: string; ok: boolean }

/** What she is told once the partner has stopped her: in the step that was cut off, and in every later one. */
export const STOPPED = '伙伴按了停下。在伙伴再跟你说话之前，不能再操作伙伴的电脑；刚才那一步做没做完不确定，别重试，先问问伙伴。';
/** How long the sign stays after her last action: long enough to see, short enough not to linger over the partner's work. */
const SIGN_LINGER_MS = 5000;
const KEPT_ACTIONS = 20;
/** The actions that send input, named as she is told about them. */
export const INPUTS: Record<string, string> = { click: '点击', drag: '拖动', swipe: '滑动', type: '输入', press: '按键', scroll: '滚动' };

/**
 * Her turns on the partner's computer, in either mode: one action at a time, in order; the sign up while she acts and
 * a little after; and the partner's stop, which cuts off the step under way and refuses every later one until they
 * speak to her. Looking at what was recorded (`review`) touches nothing, so it is neither stopped nor signed.
 */
export function createTurns<I extends { action: string }>(deps: {
  run: Record<string, (input: I) => Promise<DesktopResult>>;
  /** Shows the sign over what she is on (nothing when she is on nothing yet), or takes it away. */
  sign(show: boolean): Promise<void>;
  recording: Pick<Recording, 'running' | 'stop' | 'touched'>;
  /** What she is on, for the console's list of her last actions. */
  app(): string | undefined;
  /** She sent input; `what` is how it is named to her. */
  acted?(what: string): void;
  lingerMs?: number;
}) {
  let queue: Promise<unknown> = Promise.resolve(), halted = false, stops = 0, busy = 0, hideTimer: ReturnType<typeof setTimeout> | undefined;
  const actions: DesktopAction[] = [];

  /** Gone a little after her last action; a recording keeps it up until the recording is over. */
  function linger(): void {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = undefined; if (deps.recording.running()) linger(); else void deps.sign(false); }, deps.lingerMs ?? SIGN_LINGER_MS);
    hideTimer.unref?.();
  }
  function quiet(): void { if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; } }

  return {
    actions: Object.keys(deps.run),
    /** One action, after the ones before it; what she did is kept without what she typed. */
    act(input: I): Promise<DesktopResult> {
      const work = deps.run[input.action];
      if (!work) return Promise.reject(new Error(`不认识的 action：${input.action}，可用：${Object.keys(deps.run).join('、')}`));
      const touches = input.action !== 'review';
      const done = queue.then(async () => {
        if (touches && halted) throw new Error(STOPPED);
        const what = INPUTS[input.action];
        // Her own input may have paused or started it, so a pause made for her is no longer taken for granted.
        if (what) { deps.acted?.(what); deps.recording.touched(); }
        if (!touches) return work(input);
        const before = stops;
        busy++;
        try {
          await deps.sign(true);
          const result = await work(input);
          if (stops !== before) throw new Error(STOPPED);
          await deps.sign(true);
          return result;
        } catch (error) {
          throw stops !== before ? new Error(STOPPED) : error;
        } finally { busy--; if (!halted) linger(); }
      });
      queue = done.catch(() => {});
      const note = (ok: boolean) => { const app = deps.app(); actions.push({ at: new Date().toISOString(), action: input.action, ...(app ? { app } : {}), ok }); actions.splice(0, actions.length - KEPT_ACTIONS); };
      return done.then(result => { note(true); return result; }, error => { note(false); throw error; });
    },
    recent: () => [...actions].reverse(),
    /**
     * The partner pressed stop. What she is doing ends here, a recording stops where it is with nothing more sent to
     * the computer, and nothing reaches it until `release`. Says whether a step of hers was cut off (she hears it from
     * that step) and whether a recording was.
     */
    halt(): { cut: boolean; recording: boolean } {
      const wasRecording = deps.recording.running();
      halted = true; stops++;
      quiet();
      deps.recording.touched();
      if (wasRecording) void deps.recording.stop(true);
      return { cut: busy > 0, recording: wasRecording };
    },
    /** The partner spoke to her again: she may use the computer. */
    release(): void { halted = false; },
    halted: () => halted,
    /** When the switch goes off. */
    reset(): void { halted = false; quiet(); },
  };
}
