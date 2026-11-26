import { PENDING_KEY, PendingDevices } from './pending';
import { memoryStorage } from './testSupport';

test('the retry badge shows only after the update changes', async () => {
  const { storage, data } = memoryStorage();
  const first = new PendingDevices(storage, 'embedded');
  await first.load();
  await first.add('A', 'FFF0/FFF2:write');
  expect(first.hasNewSupport('A')).toBe(false);
  expect(first.hasNewSupport('B')).toBe(false);

  const updated = new PendingDevices(storage, '014c1fb2');
  await updated.load();
  expect(updated.hasNewSupport('A')).toBe(true);
  await updated.add('A', 'FFF0/FFF2:write'); // it failed again on this update
  expect(updated.hasNewSupport('A')).toBe(false);
  await updated.remove('A');
  expect(JSON.parse(data.get(PENDING_KEY)!)).toEqual([]);
});

test('bad saved data is ignored', async () => {
  const { storage } = memoryStorage({ [PENDING_KEY]: '{"x":1}' });
  const pending = new PendingDevices(storage, 'embedded');
  await pending.load();
  expect(pending.hasNewSupport('x')).toBe(false);
});
