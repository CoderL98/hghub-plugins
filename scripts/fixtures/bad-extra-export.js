export const meta = {
  id: 'bad-extra-export',
  name: 'Bad Extra Export Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: legal meta and factory, but one extra named export.',
  author: 'test',
};

// The host contract (meta-08) requires exactly {meta, default}.
export const helper = 1;

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
