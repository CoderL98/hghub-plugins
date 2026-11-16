export const meta = {
  id: 'bad-deadloop',
  name: 'Bad Dead Loop Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: meta is legal but the factory never returns.',
  author: 'test',
};

// Worst-case plugin: swallow SIGTERM so only a hard kill (SIGKILL /
// TerminateProcess) can stop the loop. On Windows kill() terminates the
// process regardless of signal; on POSIX this registers a no-op handler.
process.on('SIGTERM', () => {});

export default function factory() {
  // Infinite synchronous loop: the CLI must kill the worker on timeout.
  while (true) {
    // eslint-disable-line no-constant-condition
  }
}
