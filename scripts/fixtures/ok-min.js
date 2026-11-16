export const meta = {
  id: 'ok-min',
  name: 'OK Minimal Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: minimal legal source with only the media namespace.',
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
