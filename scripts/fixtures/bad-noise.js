export const meta = {
  id: 'bad-noise',
  name: 'Bad Noise Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: floods stderr forever; must trip the output cap kill.',
  author: 'test',
};

export default function factory() {
  const chunk = 'x'.repeat(64 * 1024);
  const tick = () => {
    // meta-dump redirects console.* to stderr; the cap must fire long
    // before the outer timeout.
    console.error(chunk);
    setTimeout(tick, 0);
  };
  tick();
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
