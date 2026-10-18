import type { ProjectStats } from '../domain.js';

const DAY = 86_400_000;

/** Stats with zeroes, and one entry per UTC day from `since` to today. */
export function emptyStats(since: Date, now = new Date()): ProjectStats {
  const daily: ProjectStats['daily'] = [];
  const first = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
  for (let t = first; t <= now.getTime(); t += DAY) {
    daily.push({ date: new Date(t).toISOString().slice(0, 10), delivered: 0, bounced: 0, deferred: 0, complained: 0 });
  }
  return { since, messages: 0, events: {}, bounces: { hard: 0, soft: 0, block: 0 }, daily };
}
