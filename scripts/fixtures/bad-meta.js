export const meta = {
  id: 'bad-meta',
  name: 'X'.repeat(61), // meta-05: 61 code points > 60
  version: '1.0', // meta-04: not three numeric segments
  protocol: 2, // meta-06: must be 1
  description: 'Fixture: several meta violations, factory returns normally.',
  author: 'test',
};

export default function factory() {
  return {
    media: {
      getDetail() {
        return { id: 'x', title: 'x', playlists: [] };
      },
      resolvePlayback() {
        return { streams: [] };
      },
    },
  };
}
