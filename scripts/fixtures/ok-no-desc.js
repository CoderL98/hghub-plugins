export const meta = {
  id: 'ok-no-desc',
  name: 'OK No Description Fixture',
  version: '1.0.0',
  protocol: 1,
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
