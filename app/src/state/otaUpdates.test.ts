import { updateLibraryWith, type UpdatesPort } from './otaUpdates';

const port = (over: Partial<UpdatesPort> = {}): UpdatesPort & { fetched: number } => {
  const p = {
    fetched: 0,
    enabled: true,
    check: async () => ({ isAvailable: false }),
    fetch: async () => { p.fetched += 1; },
    ...over,
  };
  return p;
};

test('off when updates are disabled', async () => {
  expect(await updateLibraryWith(port({ enabled: false }))).toBe('off');
});

test('up-to-date when nothing is available or pending', async () => {
  expect(await updateLibraryWith(port())).toBe('up-to-date');
});

test('ready after fetching an available update', async () => {
  const p = port({ check: async () => ({ isAvailable: true }) });
  expect(await updateLibraryWith(p)).toBe('ready');
  expect(p.fetched).toBe(1);
});

test('ready when an update is already pending', async () => {
  const p = port();
  expect(await updateLibraryWith(p, true)).toBe('ready');
  expect(p.fetched).toBe(0);
});

test('failed when the check or fetch throws', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  expect(await updateLibraryWith(port({ check: async () => { throw new Error('x'); } }))).toBe('failed');
  expect(await updateLibraryWith(port({ check: async () => ({ isAvailable: true }), fetch: async () => { throw new Error('y'); } }))).toBe('failed');
  log.mockRestore();
});

test('a call during a running check shares its result', async () => {
  let release!: () => void;
  const slow = port({ check: () => new Promise((r) => { release = () => r({ isAvailable: true }); }) });
  const first = updateLibraryWith(slow);
  const second = updateLibraryWith(port());
  release();
  expect(await first).toBe('ready');
  expect(await second).toBe('ready');
  expect(slow.fetched).toBe(1);
});
