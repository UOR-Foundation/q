// Members' requests, filed to UOR-Foundation/community as issues: the repository that coordinates the community.
// The kernel decides when (decision 25: consent, enough members, never twice). Here only the filing: one issue per
// request, found again by the request's BLAKE3 label, so a restart or a second process never files it twice.
// It needs a token that may open issues in that one repository; without one, nothing is filed and requests wait.

export interface FilerOptions { repository: string; token: string }

export function communityFiler(options: FilerOptions) {
  const api = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${options.token}`, 'user-agent': 'uor-foundation-q', 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return async (request: { label: string; kind: string; text: string; supporters: number }): Promise<string> => {
    // Filed before, by this process or another: the label is in the issue's body.
    const search = await api(`/search/issues?q=${encodeURIComponent(`repo:${options.repository} is:issue "${request.label}" in:body`)}`);
    if (search.ok) {
      const found = (await search.json()) as { items?: { html_url: string }[] };
      if (found.items?.length) return found.items[0].html_url;
    }
    const title = `Q ${request.kind}: ${request.text.replace(/\s+/g, ' ').slice(0, 80)}${request.text.length > 80 ? '…' : ''}`;
    const body = [
      `**${request.kind[0].toUpperCase()}${request.kind.slice(1)}** asked of Q, the Foundation's Discord agent, by ${request.supporters} members.`,
      '',
      '> ' + request.text.replace(/\n/g, '\n> '),
      '',
      `Request \`${request.label}\`: the BLAKE3 kappa label of the request record. Filed by [Q](https://github.com/UOR-Foundation/q) under its decision 25 (Policy.fileOnlyConsented, Policy.fileOnlyWithSupport): each member chose to send this with \`/feedback\`, which says it is shared here without their name.`,
    ].join('\n');
    const created = await api(`/repos/${options.repository}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) });
    if (!created.ok) throw new Error(`community issue: ${created.status} ${await created.text()}`);
    return ((await created.json()) as { html_url: string }).html_url;
  };
}
