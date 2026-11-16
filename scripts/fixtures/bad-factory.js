export const meta = {
  id: 'bad-factory',
  name: 'Bad Factory Fixture',
  version: '1.0.0',
  protocol: 1,
  description: 'Fixture: legal meta but the factory throws.',
  author: 'test',
};

export default function factory() {
  throw new Error('factory exploded');
}
