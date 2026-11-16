export const meta = {
  id: 'bad-exports',
  name: 'Bad Exports Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: no default export, only a named factory.',
  author: 'test',
};

// Named export only — the host contract requires `export default`.
export function factory() {
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
