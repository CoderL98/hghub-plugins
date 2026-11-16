export const meta = {
  id: 'ok-async',
  name: 'OK Async Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: async factory reading storage at init, plus an out-of-table namespace.',
  author: 'test',
  kind: 'source',
};

export default async function factory(hg) {
  // Pinned stub contract: storage.get must resolve to undefined (not a stub).
  const stored = await hg.storage.get('k');
  if (stored !== undefined) {
    throw new Error('expected hg.storage.get to resolve to undefined, got ' + typeof stored);
  }
  return {
    endpoints: {
      list() {
        return [{ id: 'main', label: 'main', url: 'https://example.com' }];
      },
    },
    media: {
      async getDetail() {
        return { id: 'x', title: 'x', playlists: [] };
      },
      async resolvePlayback() {
        return { streams: [] };
      },
    },
    extras: {
      async ping() {
        return 'pong';
      },
    },
  };
}
