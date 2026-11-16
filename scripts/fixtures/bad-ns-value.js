export const meta = {
  id: 'bad-ns-value',
  name: 'Bad Namespace Value Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: media complete, but search is declared as a string.',
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
    // Declared namespace with a non-object value: the host rejects it and
    // the validator must flag it via declaredNamespaces (spec §12).
    search: 'str',
  };
}
