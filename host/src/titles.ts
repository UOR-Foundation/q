// A cited source's title: short, and saying what it is. A Discord message is its channel and day, a page its site
// and path, a file its repository and path. The full link stays behind the title, and the full record (source, claim
// level, BLAKE3 label) stays in the answer record.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const bare = (path: string) => path.replace(/\.prompt\.json$|\.(md|txt|json)$/, '').replace(/^\/+|\/+$/g, '');

/**
 * A public item's area of knowledge: its repository and top folder, or its site and first path segment. Questions
 * are classed by the area of their nearest public item, so a class names public knowledge, never a member's words.
 */
export function areaOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  const file = u.hostname === 'raw.githubusercontent.com'
    ? /^\/[^/]+\/([^/]+)\/[^/]+\/(.+)$/.exec(u.pathname)
    : u.hostname === 'github.com' ? /^\/[^/]+\/([^/]+)(?:\/(?:blob|tree)\/[^/]+\/(.+))?/.exec(u.pathname) : null;
  if (file) {
    const folder = file[2]?.includes('/') ? file[2].split('/')[0] : null;
    return folder ? `${file[1]} › ${folder}` : file[1];
  }
  const first = bare(u.pathname).split('/')[0];
  const host = u.hostname.replace(/^www\./, '');
  return first && first !== 'index' ? `${host} › ${first}` : host;
}

export function titleOf(url: string, channelName: (id: string) => string | undefined = () => undefined, now = new Date()): string {
  const discord = /discord\.com\/channels\/\d+\/(\d+)\/(\d+)/.exec(url);
  if (discord) {
    // A Discord id holds the moment it was made.
    const day = new Date(Number(BigInt(discord[2]) >> 22n) + 1420070400000);
    const year = day.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${day.getUTCFullYear()}`;
    return `#${channelName(discord[1]) ?? 'discord'} · ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}${year}`;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  // A file on GitHub: its repository, then its path, without the owner, "blob" or the commit.
  const file = u.hostname === 'raw.githubusercontent.com'
    ? /^\/[^/]+\/([^/]+)\/[^/]+\/(.+)$/.exec(u.pathname)
    : u.hostname === 'github.com' ? /^\/[^/]+\/([^/]+)\/(?:blob|tree)\/[^/]+\/(.+)$/.exec(u.pathname) : null;
  if (file) return `${file[1]} › ${bare(file[2])}`;
  if (u.hostname === 'github.com') return bare(u.pathname).split('/').slice(1).join(' › ') || 'github.com';
  const path = bare(u.pathname);
  return path && path !== 'index' ? `${u.hostname.replace(/^www\./, '')} › ${path}` : u.hostname.replace(/^www\./, '');
}
