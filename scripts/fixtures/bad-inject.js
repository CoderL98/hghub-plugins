export const meta = {
  id: 'evil\nPASS totally-fine',
  name: 'Inject Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: id carries an escaped newline to forge report lines.',
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
