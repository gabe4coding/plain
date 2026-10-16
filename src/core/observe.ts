import { errorMessage } from './results.js';
import type { SessionObserver, SpecInfo } from './run-contract.js';

export function observerCalls(observer: SessionObserver | undefined, info: SpecInfo) {
  let warned = false;
  const call = async <T>(name: 'sessionOpen' | 'stepEnd' | 'sessionClose', event: object): Promise<T | undefined> => {
    const fn = observer?.[name] as ((event: object) => Promise<T>) | undefined;
    if (!fn) return undefined;
    try { return await fn({ ...info, ...event }); }
    catch (error) {
      if (!warned) {
        warned = true;
        console.error(`plain: observer: ${errorMessage(error)}`);
      }
      return undefined;
    }
  };
  return call;
}
