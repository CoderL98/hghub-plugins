export const meta = {
  id: 'bad-deadloop',
  name: 'Bad Dead Loop Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: meta is legal but the factory never returns.',
  author: 'test',
};

export default function factory() {
  // Infinite synchronous loop: the CLI must kill the worker on timeout.
  while (true) {
    // eslint-disable-line no-constant-condition
  }
}
