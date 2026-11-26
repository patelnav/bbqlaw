import { ADAPTERS, VECTORS } from '../adapters';
import { matches, runVector, type VectorCase } from './vectorRunner';

describe.each(ADAPTERS.map((a) => [a.id, a] as const))('%s golden vectors', (id, def) => {
  const cases = VECTORS[id] as VectorCase[];

  test('has vectors', () => expect(cases.length).toBeGreaterThan(0));

  test.each(cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { record, expected } = runVector(def, testCase);
    for (const key of ['writes', 'readings', 'battery', 'status'] as const) {
      if (!(key in expected)) continue;
      if (!matches(record[key], expected[key])) expect(record[key]).toEqual(expected[key]);
    }
  });
});
