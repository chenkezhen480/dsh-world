export type Complete = (messages: unknown[], options?: object, signal?: AbortSignal) => Promise<unknown>;
export function connectModel(): Complete;
