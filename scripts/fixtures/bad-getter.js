export const meta = {
  id: 'bad-getter',
  name: 'Bad Getter Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: a throwing getter on the factory result; collection must be factory-stage.',
  author: 'test',
};

export default function factory() {
  return {
    // Throwing getter (with C0/ANSI control characters in the message for
    // the report-stripping check).
    get media() {
      throw new Error('getter boom \x1b[31mred\x1b[0m \x07');
    },
  };
}
