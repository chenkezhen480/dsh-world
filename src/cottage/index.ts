import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ElsewhereSource } from '../elsewhere.ts';
import { durableWrite } from '../life/lifeStore.ts';
import { act, changeWeather, describe, goTo, newCottage, news, parseCottage, cottageView, ACTION_NAMES, type Layout, type CottageState, type Weather } from './life.ts';

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

/** The room package's places and land, read from where it is installed (it is not part of this plugin). */
export async function loadLayout(roomDir: string): Promise<Layout> {
  const layout = await import(pathToFileURL(join(roomDir, 'js', 'places.js')).href) as Layout;
  if (!layout.PLACES || typeof layout.chunkOf !== 'function' || typeof layout.chunkKey !== 'function' || !Number.isSafeInteger(layout.GENERATOR)) {
    throw new Error('装着的小屋包里没有她要用的地方和土地（js/places.js）');
  }
  return layout;
}

function toolNote(partner: string): string {
  return `我的小屋和院子。我在哪、锅里煮着什么、晾着的衣服、菜圃里种的，都是真的，${partner}在控制台的小屋里看得到我。`
    + 'action 取一种：look（看看我在哪、周围有什么、在忙的事、能去哪）｜go（place 写地方，比如 厨房、餐桌、扶手椅、书桌、床上、窗边、菜圃、晾衣绳、院门口）｜'
    + `do（do 写要做的事：${ACTION_NAMES.join('、')}；做饭要 what 写做什么，种菜要 what 写种什么；先 go 到对应的地方）。`
    + '做饭、晾衣服、种菜都要等一阵。好了或者菜缺水了，我下一次醒着时会在「别处的动静」里看到，但它不会叫醒我：要准时回来，得我自己用 plan_next 定闹钟。';
}

/**
 * Her life in the cottage, for her home only: `<world>/cottage.json` holds where she is, what is cooking, drying and
 * growing, what she changed in the yard and the weather; the land itself is made again from its seed. Nothing runs on a timer:
 * what became ready is worked out from the time whenever she or the console looks.
 */
export function createCottageModule(deps: { worldDir: string; layout: Layout; timeZone: string; partner(): string; isHome(sessionId: string): boolean; now?(): number }) {
  const file = join(deps.worldDir, 'cottage.json'), now = deps.now ?? Date.now;
  let state: CottageState = existsSync(file) ? parseCottage(JSON.parse(readFileSync(file, 'utf8')), deps.layout) : save(newCottage(randomInt(1, 2 ** 31), deps.layout, now()));
  if (state.generator !== deps.layout.GENERATOR) throw new Error(`她的院子是第 ${state.generator} 版的规则长出来的，装着的小屋包是第 ${deps.layout.GENERATOR} 版`);

  function save(next: CottageState): CottageState {
    durableWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
  function change(done: { state: CottageState; text: string }): string {
    if (done.state !== state) state = save(done.state);
    return done.text;
  }

  const tool: ToolDefinition = defineTool({
    name: 'cottage', description: toolNote(deps.partner()), output,
    parameters: { action: { type: 'string', required: true }, place: { type: 'string' }, do: { type: 'string' }, what: { type: 'string' } },
    execute: async ({ action, place, do: deed, what }) => {
      const text = (value: unknown) => typeof value === 'string' ? value : '';
      switch (action) {
        case 'look': return describe(state, deps.layout, now(), deps.timeZone);
        case 'go': if (!text(place).trim()) throw new Error('go 要写 place'); return change(goTo(state, deps.layout, text(place), now()));
        case 'do': if (!text(deed).trim()) throw new Error(`do 要写做什么：${ACTION_NAMES.join('、')}`); return change(act(state, deps.layout, text(deed), text(what), now()));
        default: throw new Error('action 只能是 look、go 或 do');
      }
    },
  });

  // Told at home only: that is where her cottage tool is.
  const elsewhere: ElsewhereSource = { look: '小屋用 cottage look 看', news: (at, session) => deps.isHome(session.id) ? news(state, at.getTime()) : [] };
  return {
    /** Her tools while the module runs (the tool registry keeps them to her world). */
    tools: () => [tool],
    elsewhere,
    view: () => cottageView(state, now()),
    /** Her partner sets the weather from the console. */
    setWeather(kind: Weather): void { change({ state: changeWeather(state, kind, now()), text: '' }); },
  };
}
export type CottageModule = ReturnType<typeof createCottageModule>;
