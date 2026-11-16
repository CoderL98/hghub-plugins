export const meta = {
  id: 'bad-logs',
  name: 'Bad Logs Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: noisy console output at import time and inside the factory.',
  author: 'test',
  kind: 'source',
};

console.log('top-level noise from bad-logs');

export default function factory(hg) {
  console.log('factory noise from bad-logs', typeof hg);
  return {
    home: {
      async getSections() {
        return { items: [], next: null };
      },
    },
  };
}
